import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { prepare } from "../../src/commands/blog/prepare.ts";
import { createApp } from "../../src/kit/index.ts";
import {
  applyBlogPrepare,
  applyBlogPreparePlans,
  checkBlog,
  createPrepareSession,
  DEFAULT_BLOG_CONFIG,
  loadBlogConfig,
  planBlogPrepare,
  resolveBlogConfig,
  resolveBlogProject,
} from "../../src/lib/blog.ts";
import { capture } from "../support/io.ts";

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

describe("prepare safety regressions", () => {
  test("uses the same root from the project or nested posts directory", async () => {
    const root = await temporary();
    const posts = join(root, "content", "posts");
    await mkdir(join(posts, "hello"), { recursive: true });
    await writeFile(join(posts, "hello", "index.md"), "# Hello\n");
    const config = resolveBlogConfig({ postsDir: "content/posts" });
    const fromRoot = await resolveBlogProject(root, root, config);
    const fromPosts = await resolveBlogProject(posts, root, config);
    expect(fromPosts).toEqual(fromRoot);
    expect(fromPosts.posts[0]?.projectRoot).toBe(root);
  });

  test("shows the full preview before confirmation and leaves files untouched on refusal", async () => {
    const root = await createProject();
    const stdout = capture();
    const stderr = capture();
    const entry = join(root, "posts", "hello", "readme.mdx");
    const original = await readFile(entry, "utf8");
    let prompted = false;
    const app = createApp(prepare, {
      context: (base) => ({
        ...base,
        log: { info() {}, debug() {} },
        readStdin: async () => "",
        async confirm() {
          prompted = true;
          expect(stdout.text).toContain("remove Notion export artifact");
          expect(stdout.text).toContain("cover.webp");
          expect(await readFile(entry, "utf8")).toBe(original);
          expect(await Bun.file(join(root, "posts", "hello", "cover.webp")).exists()).toBe(false);
          return false;
        },
      }),
    });
    expect(await app.run([root], { cwd: root, stdout, stderr })).toBe(1);
    expect(prompted).toBe(true);
    expect(await readFile(entry, "utf8")).toBe(original);
  });

  test("keeps literal Notion markers and invisible characters inside code", async () => {
    const root = await temporary();
    const entry = join(root, "index.mdx");
    const literal = "<!-- notionvc: example -->\n<empty-block />\nconst text = 'x\u200by';";
    await writeFile(entry, `# Example\n\n\`\`\`html\n${literal}\n\`\`\`\n\nProse\u200b text.\n`);
    const config = resolveBlogConfig();
    const project = await resolveBlogProject(entry, root, config);
    const plan = await planBlogPrepare(project.posts[0]!, config, { cwd: root });
    expect(plan.prepared).toContain(literal);
    expect(plan.prepared).toContain("Prose text.");
    expect(plan.unicodeReplacements).toBe(1);
  });

  test("refuses changed image sources before publishing anything", async () => {
    const root = await createProject();
    const { config } = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, config);
    const plan = await planBlogPrepare(project.posts[0]!, config, { cwd: root });
    await writeFile(plan.images[0]!.input, "changed source");
    await expect(applyBlogPrepare(plan, config)).rejects.toThrow("changed after planning");
    expect(await Bun.file(plan.images[0]!.output).exists()).toBe(false);
    expect(await readFile(plan.entry, "utf8")).toBe(plan.original);
  });

  test("preflights all entries before the first write", async () => {
    const root = await createProject();
    const { config } = await loadBlogConfig(root);
    const first = (await resolveBlogProject(root, root, config)).posts[0]!;
    const secondRoot = join(root, "posts", "second");
    await mkdir(secondRoot);
    const secondEntry = join(secondRoot, "readme.mdx");
    await writeFile(secondEntry, "Second\u200b post.\n");
    const second = (await resolveBlogProject(secondEntry, root, config)).posts[0]!;
    const session = createPrepareSession();
    const plans = await Promise.all(
      [first, second].map((post) => planBlogPrepare(post, config, { cwd: root, session })),
    );
    await writeFile(secondEntry, "user edits\n");
    await expect(applyBlogPreparePlans(plans, config)).rejects.toThrow("changed after planning");
    expect(await readFile(first.entry, "utf8")).toBe(plans[0]!.original);
    expect(await Bun.file(plans[0]!.images[0]!.output).exists()).toBe(false);
  });

  test("deduplicates a shared image and retains public originals", async () => {
    const root = await createProject();
    await mkdir(join(root, "public"));
    await mkdir(join(root, "posts", "second"));
    await sharp({ create: { width: 100, height: 100, channels: 3, background: "red" } })
      .png()
      .toFile(join(root, "public", "shared.png"));
    for (const name of ["hello", "second"]) {
      await writeFile(join(root, "posts", name, "readme.mdx"), `# ${name}\n\n![shared](/shared.png)\n`);
    }
    const config = resolveBlogConfig({
      entries: ["readme.mdx"],
      publicDir: "public",
      prepare: { deleteOriginals: true },
    });
    const project = await resolveBlogProject(root, root, config);
    const session = createPrepareSession();
    const plans = [];
    for (const post of project.posts) plans.push(await planBlogPrepare(post, config, { cwd: root, session }));
    expect(plans[0]!.images[0]!.output).toBe(plans[1]!.images[0]!.output);
    expect(plans[0]!.images[0]!.data).toBe(plans[1]!.images[0]!.data);
    const results = await applyBlogPreparePlans(plans, config);
    expect(results.flatMap((result) => result.deletedOriginals)).toEqual([]);
    expect(results[0]!.retainedOriginals[0]!.reason).toContain("shared or public");
    expect(await Bun.file(join(root, "public", "shared.png")).exists()).toBe(true);
    for (const plan of plans) expect(await readFile(plan.entry, "utf8")).toContain("/shared.webp");
  });

  test("retains a post-local original referenced by unselected metadata", async () => {
    const root = await createProject();
    const loaded = await loadBlogConfig(root);
    const config = { ...loaded.config, prepare: { ...loaded.config.prepare, deleteOriginals: true } };
    const project = await resolveBlogProject(root, root, config);
    await writeFile(join(root, "posts", "hello", "meta.json"), JSON.stringify({ cover: "./cover.png" }));
    const plan = await planBlogPrepare(project.posts[0]!, config, { cwd: root });
    const result = await applyBlogPrepare(plan, config);
    expect(result.deletedOriginals).toEqual([]);
    expect(result.retainedOriginals[0]!.reason).toContain("meta.json");
    expect(await Bun.file(plan.images[0]!.input).exists()).toBe(true);
  });

  test("never deletes an image whose destination cannot be rewritten", async () => {
    const root = await createProject();
    const loaded = await loadBlogConfig(root);
    const config = { ...loaded.config, prepare: { ...loaded.config.prepare, deleteOriginals: true } };
    const project = await resolveBlogProject(root, root, config);
    await writeFile(project.posts[0]!.entry, "# Example\n\n![cover](cover\\.png)\n");
    const plan = await planBlogPrepare(project.posts[0]!, config, { cwd: root });
    expect(plan.images).toEqual([]);
    await applyBlogPrepare(plan, config);
    expect(await Bun.file(join(root, "posts", "hello", "cover.png")).exists()).toBe(true);
  });
  test("rewrites shared relative image paths for each post independently", async () => {
    const root = await createProject();
    await mkdir(join(root, "posts", "second"));
    await writeFile(
      join(root, "posts", "second", "readme.mdx"),
      "# Second\n\n![cover](../hello/cover.png)\n",
    );
    const { config } = await loadBlogConfig(root);
    const project = await resolveBlogProject(root, root, config);
    const session = createPrepareSession();
    const plans = [];
    for (const post of project.posts) plans.push(await planBlogPrepare(post, config, { cwd: root, session }));
    expect(plans[0]!.prepared).toContain("(cover.webp)");
    expect(plans[1]!.prepared).toContain("(../hello/cover.webp)");
    expect(plans[0]!.images[0]!.output).toBe(plans[1]!.images[0]!.output);
    await applyBlogPreparePlans(plans, config);
    expect(await readFile(plans[1]!.entry, "utf8")).toContain("(../hello/cover.webp)");
  });

  test("returns an inspectable JSON plan when --yes is missing", async () => {
    const root = await createProject();
    const stdout = capture();
    const stderr = capture();
    const app = createApp(prepare, {
      context: (base) => ({
        ...base,
        log: { info() {}, debug() {} },
        readStdin: async () => "",
        async confirm() {
          throw new Error("JSON mode must not prompt");
        },
      }),
    });
    expect(await app.run([root, "--json"], { cwd: root, stdout, stderr })).toBe(1);
    const result = JSON.parse(stdout.text);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("--yes");
    expect(result.posts).toHaveLength(1);
    expect(await Bun.file(join(root, "posts", "hello", "cover.webp")).exists()).toBe(false);
  });
});
