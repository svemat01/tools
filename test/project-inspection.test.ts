import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { app } from "../src/app.ts";
import { INSPECT_ENTRY_LIMIT, inspectPath } from "../src/lib/inspect.ts";
import { discoverProject, loadProjectConfig, ProjectConfigSchema } from "../src/lib/project.ts";
import { runApp } from "./support/io.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp("/tmp/sv-project-");
  await writeFile(join(root, "package.json"), "{}");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const put = (name: string, value: string) => writeFile(join(root, name), value);
const run = (argv: string[]) => runApp(app, argv, { cwd: root, env: { PATH: "/nonexistent" } });

describe("project resolution", () => {
  test("nearest ancestor wins, with explicit marker precedence at a root", async () => {
    await put("sv.config.json", '{"schemaVersion":1}');
    await put("sv.blog.json", "{}");
    await put("package.json", "{}");
    await mkdir(join(root, "nested", "child"), { recursive: true });
    expect(await discoverProject(join(root, "nested", "child"))).toEqual({ root, marker: "sv.config.json" });
    await writeFile(join(root, "nested", "package.json"), "{}");
    expect(await discoverProject(join(root, "nested", "child"))).toEqual({
      root: join(root, "nested"),
      marker: "package.json",
    });
    await put("sv.config.json", '{"schemaVersion":2}');
    await expect(loadProjectConfig(root)).rejects.toThrow("Invalid project config");
  });
  test("blog marker order and git before package, including malformed configs", async () => {
    await mkdir(join(root, ".sv"));
    await put(".sv/blog.json", "{}");
    await put("blog.config.json", "{}");
    expect((await discoverProject(root))?.marker).toBe(".sv/blog.json");
    await put("sv.blog.json", "{");
    expect((await discoverProject(root))?.marker).toBe("sv.blog.json");
    await expect(loadProjectConfig(root)).rejects.toThrow("Invalid blog config");
    await rm(join(root, "sv.blog.json"));
    await rm(join(root, ".sv"), { recursive: true });
    await rm(join(root, "blog.config.json"));
    await put(".git", "gitdir: somewhere");
    await put("package.json", "{}");
    expect((await discoverProject(root))?.marker).toBe(".git");
  });
  test("config v1 rejects deferred fields and doctor errors redact contents", async () => {
    expect(ProjectConfigSchema.safeParse({ schemaVersion: 1, presets: {} }).success).toBe(false);
    await put("sv.config.json", '{"secret":"sensitive-value"}');
    const result = await run(["doctor", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("sensitive-value");
    expect(JSON.parse(result.stdout).checks).toContainEqual(
      expect.objectContaining({ name: "project", status: "error" }),
    );
  });
});

describe("inspect", () => {
  test("image and Markdown metadata; CLI wiring and no writes", async () => {
    await sharp({ create: { width: 12, height: 8, channels: 3, background: "red" } })
      .png()
      .toFile(join(root, "a.png"));
    await put("post.md", "# A title\n\nHello");
    const before = await readdir(root);
    const image = JSON.parse((await run(["inspect", "a.png", "--json"])).stdout).result;
    expect(image.kind).toBe("image");
    expect(image.metadata.value).toMatchObject({ width: 12, height: 8, format: "png" });
    expect(image.suggestions[0].argv).toEqual(["img", "info", join(root, "a.png")]);
    const markdown = JSON.parse((await run(["inspect", "post.md", "--json"])).stdout).result;
    expect(markdown).toMatchObject({ kind: "markdown", metadata: { title: "A title", truncated: false } });
    expect(await readdir(root)).toEqual(before);
  });
  test("missing ffprobe produces partial success and actionable metadata", async () => {
    await put("clip.mp4", "not a video");
    const result = await run(["inspect", "clip.mp4", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).result).toMatchObject({
      kind: "video",
      metadata: { status: "unavailable", action: expect.stringContaining("FFmpeg") },
    });
  });
  test("video probe restricts protocols and returns decoded metadata", async () => {
    await put("clip.mp4", "fake");
    await put(
      "ffprobe",
      `#!/bin/sh
[ "$1" = "-protocol_whitelist" ] && [ "$2" = "file,pipe" ] || exit 9
printf '%s' '{"streams":[{"codec_type":"video","codec_name":"vp9","width":20,"height":10}],"format":{"duration":"2.5"}}'
`,
    );
    await chmod(join(root, "ffprobe"), 0o755);
    const result = await runApp(app, ["inspect", "clip.mp4", "--json"], { cwd: root, env: { PATH: root } });
    expect(JSON.parse(result.stdout).result).toMatchObject({
      kind: "video",
      metadata: { status: "available", value: { width: 20, height: 10, duration: 2.5 } },
    });
  });
  test("root cwd option is respected and Markdown reads are capped", async () => {
    await put("long.md", "# Title\n" + "x".repeat(70000));
    const result = await runApp(app, ["--cwd", root, "inspect", "long.md", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).result.metadata).toMatchObject({
      title: "Title",
      sampledBytes: 65536,
      truncated: true,
    });
  });
  test("directory samples are bounded and skip generated trees and symlinks", async () => {
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "hidden.md"), "# Hidden");
    await symlink(join(root, "node_modules"), join(root, "linked"));
    const options = { cwd: root, env: { PATH: "/nonexistent" } };
    const small = await inspectPath(".", options);
    expect("summary" in small && small.summary.entries).toEqual([{ name: "package.json", kind: "other" }]);
    for (let i = 0; i < INSPECT_ENTRY_LIMIT + 2; i++) await put(`${i}.md`, "# Test");
    const large = await inspectPath(".", options);
    expect("summary" in large && large.summary.truncated).toBe(true);
    expect("summary" in large && large.summary.entries.length).toBeLessThanOrEqual(INSPECT_ENTRY_LIMIT);
    expect((await inspectPath("linked/hidden.md", options)).kind).toBe("error");
    expect((await run(["inspect", "missing", "--json"])).code).toBe(1);
  });
  test("classifies blog and project directories; cancellation is an error", async () => {
    await put("sv.blog.json", "{}");
    expect(JSON.parse((await run(["inspect", ".", "--json"])).stdout).result.kind).toBe("blog");
    await rm(join(root, "sv.blog.json"));
    await put("sv.config.json", '{"schemaVersion":1}');
    expect(JSON.parse((await run(["inspect", ".", "--json"])).stdout).result.kind).toBe("project");
    expect((await inspectPath(".", { cwd: root, env: {}, signal: AbortSignal.abort() })).kind).toBe("error");
  });
});

describe("init and doctor", () => {
  test("dry run previews; JSON requires yes; creation never overwrites", async () => {
    const dry = await run(["init", "--dry-run", "--yes", "--json"]);
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.stdout).status).toBe("planned");
    expect(dry.stderr).toContain('"schemaVersion": 1');
    expect(await readdir(root)).toEqual(["package.json"]);
    expect((await run(["init", "--json"])).code).toBe(1);
    expect(await readdir(root)).toEqual(["package.json"]);
    const created = await run(["init", "--yes", "--json"]);
    expect(JSON.parse(created.stdout).status).toBe("created");
    const bytes = await readFile(join(root, "sv.config.json"), "utf8");
    expect(JSON.parse(bytes)).toEqual({ schemaVersion: 1 });
    expect(JSON.parse((await run(["init", "--yes", "--json"])).stdout).status).toBe("existing");
    expect(await readFile(join(root, "sv.config.json"), "utf8")).toBe(bytes);
  });
  test("init recognizes ancestor blog config without rewriting", async () => {
    await put("sv.blog.json", "{}\n");
    await mkdir(join(root, "posts"));
    const result = await runApp(app, ["init", "--yes", "--json"], { cwd: join(root, "posts") });
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "existing",
      root,
      path: join(root, "sv.blog.json"),
    });
    expect((await readdir(root)).sort()).toEqual(["package.json", "posts", "sv.blog.json"]);
    expect(await readFile(join(root, "sv.blog.json"), "utf8")).toBe("{}\n");
  });
  test("missing optional tools warn but doctor succeeds and never exposes env values", async () => {
    await put("sv.config.json", '{"schemaVersion":1}');
    const result = await runApp(app, ["doctor", "--json"], {
      cwd: root,
      env: { PATH: "/nonexistent", SECRET: "private-env-value" },
    });
    expect(result.code).toBe(0);
    expect(
      JSON.parse(result.stdout).checks.filter((check: { status: string }) => check.status === "warning"),
    ).toHaveLength(4);
    expect(result.stdout).not.toContain("private-env-value");
    expect(result.stderr).toBe("");
  });
  test("init refuses symlink config without replacing its target", async () => {
    await put("original.json", '{"schemaVersion":1}');
    await symlink(join(root, "original.json"), join(root, "sv.config.json"));
    expect((await run(["init", "--yes", "--json"])).code).toBe(1);
    expect(await readFile(join(root, "original.json"), "utf8")).toBe('{"schemaVersion":1}');
  });
});
