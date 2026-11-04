import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import {
  applyBlogPrepare,
  checkBlog,
  DEFAULT_BLOG_CONFIG,
  loadBlogConfig,
  planBlogPrepare,
  resolveBlogConfig,
  resolveBlogProject,
} from "../../src/lib/blog.ts";

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sv-blog-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createProject(): Promise<string> {
  const root = await temporary();
  await mkdir(join(root, "posts", "hello"), { recursive: true });
  await writeFile(
    join(root, "sv.blog.json"),
    JSON.stringify({
      name: "Test Blog",
      postsDir: "posts",
      entries: ["readme.mdx"],
      metadataFiles: ["meta.json"],
      requiredMetadata: ["title", "slug"],
      slugField: "slug",
      prepare: { imageFormat: "webp", imageWidth: 800, imageQuality: 80 },
    }),
  );
  await writeFile(
    join(root, "posts", "hello", "meta.json"),
    JSON.stringify({ title: "Hello", slug: "hello" }),
  );
  await sharp({
    create: { width: 1600, height: 900, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 1 } },
  })
    .png()
    .toFile(join(root, "posts", "hello", "cover.png"));
  await writeFile(
    join(root, "posts", "hello", "readme.mdx"),
    [
      "---",
      "title: Hello",
      "slug: hello",
      "---",
      "",
      "# Hello",
      "",
      "A paragraph with a zero-width\u200b space.",
      "",
      "![cover](./cover.png)",
      "",
      "[tracked](https://example.com/page?utm_source=newsletter&id=1)",
      "",
      "<!-- notionvc: abc123 -->",
      "",
    ].join("\n"),
  );
  return root;
}

describe("resolveBlogConfig", () => {
  test("uses generic defaults", () => {
    expect(DEFAULT_BLOG_CONFIG.postsDir).toBe("posts");
    expect(DEFAULT_BLOG_CONFIG.entries).toContain("readme.mdx");
    expect(DEFAULT_BLOG_CONFIG.prepare.deleteOriginals).toBe(false);
  });

  test("merges nested check and prepare overrides without dropping defaults", () => {
    const config = resolveBlogConfig({
      name: "Mine",
      checks: { unicode: false },
      prepare: { imageFormat: "keep", imageWidth: 1200 },
    });
    expect(config.name).toBe("Mine");
    expect(config.checks.unicode).toBe(false);
    expect(config.checks.links).toBe(true);
    expect(config.prepare.imageFormat).toBe("keep");
    expect(config.prepare.imageWidth).toBe(1200);
    expect(config.prepare.stripTracking).toBe(true);
  });
});

describe("loadBlogConfig", () => {
  test("discovers sv.blog.json in the start directory", async () => {
    const root = await createProject();
    const loaded = await loadBlogConfig(root);
    expect(loaded.source).toBe(join(root, "sv.blog.json"));
    expect(loaded.config.name).toBe("Test Blog");
  });

  test("resolves an explicit config relative to the start directory", async () => {
    const root = await createProject();
    const loaded = await loadBlogConfig(root, "sv.blog.json");
    expect(loaded.source).toBe(join(root, "sv.blog.json"));
  });

  test("rejects an invalid config with a useful message", async () => {
    const root = await temporary();
    await writeFile(join(root, "sv.blog.json"), JSON.stringify({ postsDir: 42 }));
    await expect(loadBlogConfig(root)).rejects.toThrow("Invalid blog config");
  });

  test("the ENS example config is valid", async () => {
    const example = join(import.meta.dir, "..", "..", "examples", "ens-blog");
    const loaded = await loadBlogConfig(example);
    expect(loaded.config.name).toBe("ENS Blog");
    expect(loaded.config.postsDir).toBe("posts");
    expect(loaded.config.prepare.imageFormat).toBe("webp");
  });
});

describe("checkBlog", () => {
  test("accepts a valid post", async () => {
    const root = await createProject();
    await writeFile(
      join(root, "posts", "hello", "readme.mdx"),
      "---\ntitle: Hello\nslug: hello\n---\n\n# Hello\n\nA clean paragraph.\n",
    );
    const loaded = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, loaded.config);
    const summary = await checkBlog(project, loaded.config, { cwd: root });
    expect(summary.posts).toBe(1);
    expect(summary.errors).toBe(0);
    expect(summary.ok).toBe(true);
  });

  test("reports missing metadata, broken links and missing alt text", async () => {
    const root = await createProject();
    await writeFile(join(root, "posts", "hello", "meta.json"), JSON.stringify({ title: "Hello" }));
    await writeFile(
      join(root, "posts", "hello", "readme.mdx"),
      ["# Hello", "", "![](./missing.png)", "", "[broken](./missing.md)", ""].join("\n"),
    );
    const loaded = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, loaded.config);
    const summary = await checkBlog(project, loaded.config, { cwd: root });
    expect(summary.ok).toBe(false);
    expect(summary.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["missing-metadata", "missing-media", "broken-link", "missing-alt-text"]),
    );
  });

  test("detects duplicate slugs across posts", async () => {
    const root = await createProject();
    await mkdir(join(root, "posts", "second"), { recursive: true });
    await writeFile(
      join(root, "posts", "second", "meta.json"),
      JSON.stringify({ title: "Second", slug: "hello" }),
    );
    await writeFile(
      join(root, "posts", "second", "readme.mdx"),
      "---\ntitle: Second\nslug: hello\n---\n\n# Second\n",
    );
    const loaded = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, loaded.config);
    const summary = await checkBlog(project, loaded.config, { cwd: root });
    expect(summary.issues.filter((issue) => issue.code === "duplicate-slug")).toHaveLength(2);
  });
});

describe("planBlogPrepare and applyBlogPrepare", () => {
  test("removes Notion artifacts, tracking parameters and invisible characters, and rewrites images", async () => {
    const root = await createProject();
    const loaded = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, loaded.config);
    const plan = await planBlogPrepare(project.posts[0]!, loaded.config, { cwd: root });

    expect(plan.changed).toBe(true);
    expect(plan.images).toHaveLength(1);
    expect(plan.images[0]?.nextUrl).toBe("cover.webp");
    expect(plan.edits.map((edit) => edit.reason).join("\n")).toContain("Notion");
    expect(plan.edits.map((edit) => edit.reason).join("\n")).toContain("tracking");
    expect(plan.prepared).not.toContain("notionvc");
    expect(plan.prepared).not.toContain("utm_source");
    expect(plan.prepared).not.toContain("\u200b");
    expect(plan.prepared).toContain("cover.webp");

    const result = await applyBlogPrepare(plan, loaded.config);
    expect(result.writtenImages).toEqual([join(root, "posts", "hello", "cover.webp")]);
    expect(result.deletedOriginals).toEqual([]);

    const prepared = await readFile(join(root, "posts", "hello", "readme.mdx"), "utf8");
    expect(prepared).toContain("cover.webp");
    expect(prepared).not.toContain("utm_source");
    expect(prepared).not.toContain("notionvc");
    expect(prepared).not.toContain("\u200b");
    // Originals are preserved unless deleteOriginals is explicitly enabled.
    expect(await Bun.file(join(root, "posts", "hello", "cover.png")).exists()).toBe(true);
  });

  test("deletes replaced originals only when configured", async () => {
    const root = await createProject();
    const loaded = await loadBlogConfig(root);
    const config = { ...loaded.config, prepare: { ...loaded.config.prepare, deleteOriginals: true } };
    const project = await resolveBlogProject(root, root, config);
    const plan = await planBlogPrepare(project.posts[0]!, config, { cwd: root });
    const result = await applyBlogPrepare(plan, config);

    expect(result.deletedOriginals).toEqual([join(root, "posts", "hello", "cover.png")]);
    expect(await Bun.file(join(root, "posts", "hello", "cover.png")).exists()).toBe(false);
    expect(await Bun.file(join(root, "posts", "hello", "cover.webp")).exists()).toBe(true);
  });

  test("honours --no-images and --no-unicode", async () => {
    const root = await createProject();
    const loaded = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, loaded.config);
    const plan = await planBlogPrepare(project.posts[0]!, loaded.config, {
      cwd: root,
      noImages: true,
      noUnicode: true,
    });
    expect(plan.images).toEqual([]);
    expect(plan.prepared).toContain("./cover.png");
    expect(plan.prepared).toContain("\u200b");
  });

  test("reports no changes for an already clean post", async () => {
    const root = await createProject();
    await writeFile(
      join(root, "posts", "hello", "readme.mdx"),
      "---\ntitle: Hello\nslug: hello\n---\n\n# Hello\n\nA clean paragraph.\n",
    );
    const loaded = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, loaded.config);
    const plan = await planBlogPrepare(project.posts[0]!, loaded.config, { cwd: root });
    expect(plan.changed).toBe(false);
    expect(plan.edits).toEqual([]);
  });

  test("refuses to apply a plan after the entry changed", async () => {
    const root = await createProject();
    const loaded = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, loaded.config);
    const plan = await planBlogPrepare(project.posts[0]!, loaded.config, { cwd: root });

    await writeFile(join(root, "posts", "hello", "readme.mdx"), "edited after planning\n");
    await expect(applyBlogPrepare(plan, loaded.config)).rejects.toThrow("changed after planning");
    expect(await Bun.file(join(root, "posts", "hello", "cover.webp")).exists()).toBe(false);
  });

  test("resolves a nested postsDir to the project root", async () => {
    const root = await temporary();
    await mkdir(join(root, "content", "posts", "hello"), { recursive: true });
    await writeFile(join(root, "content", "posts", "hello", "index.mdx"), "# Hello\n");
    const config = resolveBlogConfig({
      postsDir: "content/posts",
      entries: ["index.mdx"],
      metadataFiles: [],
      requiredMetadata: [],
    });

    const project = await resolveBlogProject(join(root, "content", "posts", "hello"), root, config);
    expect(project.kind).toBe("post");
    expect(project.projectRoot).toBe(root);
  });

  test("preserves root-relative image URLs through publicDir", async () => {
    const root = await temporary();
    await mkdir(join(root, "public", "images"), { recursive: true });
    await mkdir(join(root, "posts", "hello"), { recursive: true });
    await sharp({
      create: { width: 1600, height: 900, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .png()
      .toFile(join(root, "public", "images", "cover.png"));
    await writeFile(join(root, "posts", "hello", "index.mdx"), "# Hello\n\n![cover](/images/cover.png)\n");
    const config = resolveBlogConfig({
      postsDir: "posts",
      entries: ["index.mdx"],
      metadataFiles: [],
      requiredMetadata: [],
      publicDir: "public",
      prepare: { imageFormat: "webp", imageWidth: 800 },
    });

    const project = await resolveBlogProject(root, root, config);
    const plan = await planBlogPrepare(project.posts[0]!, config, { cwd: root });
    expect(plan.prepared).toContain("(/images/cover.webp)");
  });
});
