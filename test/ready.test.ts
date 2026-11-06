import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { app, sv } from "../src/app.ts";
import { createContext } from "../src/context.ts";
import { createApp } from "../src/kit/index.ts";
import { selectGitChanges } from "../src/lib/git-selection.ts";
import { runCommand } from "../src/lib/process.ts";
import { applyReady, inspectReady, planReady } from "../src/lib/ready.ts";
import { capture, runApp } from "./support/io.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sv-ready-test-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  return { cwd, env: { XDG_STATE_HOME: join(root, "state"), PATH: process.env.PATH } };
}
async function image(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await sharp({ create: { width: 16, height: 8, channels: 3, background: "red" } })
    .png()
    .toFile(path);
}
const absent = async (path: string) => expect(await stat(path).catch(() => null)).toBeNull();
test("mixed preview is read-only and reports checks, unsupported files and explicit report plans", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "hero.png"));
  await writeFile(join(opts.cwd, "post.md"), "# Hello\n[bad](missing.md)\ntext\u200b\n");
  await writeFile(join(opts.cwd, "notes.txt"), "notes");
  const before = await readdir(opts.cwd);
  const result = await runApp(app, ["ready", ".", "--review", "--json"], opts);
  expect(result.code).toBe(1);
  const data = JSON.parse(result.stdout);
  expect(data.status).toBe("blocked");
  expect(data.checks.errors).toBeGreaterThan(0);
  expect(data.actions.map((a: { kind: string }) => a.kind)).toEqual(["image", "review"]);
  expect(data.entries.find((e: { kind: string }) => e.kind === "other").status).toBe("unsupported");
  expect(data.entries.find((e: { kind: string }) => e.kind === "markdown").issues.length).toBeGreaterThan(0);
  expect(await readdir(opts.cwd)).toEqual(before);
  await absent(opts.env.XDG_STATE_HOME);
  await absent(join(opts.cwd, ".sv-ready"));
});
test("--yes applies images and review in one receipt; undo preserves originals and removes outputs", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "input.png"));
  const original = await readFile(join(opts.cwd, "input.png"));
  const result = await runApp(app, ["ready", "input.png", "--yes", "--review", "--json"], opts);
  expect(result.code).toBe(0);
  const data = JSON.parse(result.stdout);
  expect(data.status).toBe("applied");
  expect(data.receipt.files).toHaveLength(2);
  expect((await sharp(data.actions[0].destination).metadata()).format).toBe("webp");
  expect(await readFile(data.actions[1].destination, "utf8")).toContain("sv image review");
  expect((await runApp(app, ["history", data.recordId, "--json"], opts)).code).toBe(0);
  expect((await runApp(app, ["undo", data.recordId, "--yes", "--json"], opts)).code).toBe(0);
  for (const action of data.actions) await absent(action.destination);
  expect(await readFile(join(opts.cwd, "input.png"))).toEqual(original);
});
test("stale snapshot aborts the entire plan before outputs or history", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "a.png"));
  await image(join(opts.cwd, "b.png"));
  const inspected = await inspectReady(["."], opts);
  // The encoder must use the inspection snapshot, not this new source.
  await writeFile(join(opts.cwd, "b.png"), "changed");
  const plan = await planReady(inspected);
  expect(plan.actions).toHaveLength(2);
  await expect(applyReady(plan)).rejects.toThrow("Input changed");
  await absent(join(opts.cwd, ".sv-ready"));
  await absent(opts.env.XDG_STATE_HOME);
});
test("global destinations reserve duplicate basenames; generated outputs are excluded", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "a/same.png"));
  await image(join(opts.cwd, "b/same.png"));
  const args = ["ready", ".", "--out-dir", "outputs", "--json"];
  const result = JSON.parse((await runApp(app, args, opts)).stdout);
  expect(result.actions.map((a: { destination: string }) => a.destination)).toEqual([
    join(opts.cwd, "outputs/same.webp"),
    join(opts.cwd, "outputs/same-1.webp"),
  ]);
  await runApp(app, [...args, "--yes"], opts);
  const next = JSON.parse((await runApp(app, args, opts)).stdout);
  expect(next.actions).toHaveLength(2);
  expect(next.entries.some((e: { kind: string }) => e.kind === "generated")).toBe(true);
});
test("missing, broken, config failures block all writes; unknown types are honest unsupported entries", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "ok.png"));
  for (const target of ["missing.png", "broken.png"]) {
    if (target === "broken.png") await writeFile(join(opts.cwd, target), "bad");
    const result = await runApp(app, ["ready", "ok.png", target, "--yes", "--json"], opts);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe("blocked");
    await absent(join(opts.cwd, ".sv-ready"));
    await absent(opts.env.XDG_STATE_HOME);
  }
  await writeFile(join(opts.cwd, "sv.config.json"), '{"schemaVersion":2}');
  const config = await runApp(app, ["ready", "ok.png", "--yes", "--json"], opts);
  expect(config.code).toBe(1);
  expect(config.stdout).toContain("Invalid project config");
});
test("--cwd, format/width/quality wiring, dry-run, JSON approval and cancellation", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "input.png"));
  const args = [
    "--cwd",
    opts.cwd,
    "ready",
    "input.png",
    "--width",
    "8",
    "--quality",
    "60",
    "--format",
    "avif",
    "--json",
  ];
  const preview = await runApp(app, [...args, "--yes", "--dry-run"], opts);
  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.stdout).status).toBe("planned");
  await absent(opts.env.XDG_STATE_HOME);
  expect((await runApp(app, [...args, "--apply"], opts)).code).toBe(1);
  expect((await runApp(app, ["ready", "input.png", "--apply"], opts)).code).toBe(1);
  await absent(join(opts.cwd, ".sv-ready"));
  const applied = await runApp(app, [...args, "--yes"], opts);
  expect(applied.code).toBe(0);
  const meta = await sharp(JSON.parse(applied.stdout).actions[0].destination).metadata();
  expect(meta.width).toBe(8);
  expect(meta.format).toBe("heif");
  const controller = new AbortController();
  controller.abort();
  await expect(inspectReady(["input.png"], { ...opts, signal: controller.signal })).rejects.toThrow();
  expect((await runApp(app, ["ready", "input.png", "--width", "0"], opts)).code).toBe(2);
});
async function git(cwd: string, ...args: string[]) {
  const result = await runCommand("git", args, {
    cwd,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  expect(result.code).toBe(0);
  return result;
}
test("changed selection handles unborn HEAD, staged/unstaged/untracked, newline names, deletion, scopes and clean", async () => {
  const opts = await setup();
  await git(opts.cwd, "init");
  await mkdir(join(opts.cwd, "posts"));
  const staged = join(opts.cwd, "posts/staged file.png"),
    untracked = join(opts.cwd, "posts/new\nline.png");
  await image(staged);
  await image(untracked);
  await git(opts.cwd, "add", "--", "posts/staged file.png");
  expect((await selectGitChanges(["posts"], opts)).files).toEqual([untracked, staged]);
  await git(
    opts.cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  await writeFile(staged, "modified");
  await writeFile(join(opts.cwd, "outside.txt"), "outside");
  let selection = await selectGitChanges(["posts"], opts);
  expect(selection.files).toEqual([untracked, staged]);
  await rm(staged);
  selection = await selectGitChanges(["posts"], opts);
  expect(selection.deleted).toEqual([staged]);
  expect(selection.files).toEqual([untracked]);
  await rm(untracked);
  const deleted = await runApp(app, ["ready", "posts", "--changed", "--json"], opts);
  expect(deleted.code).toBe(0);
  expect(JSON.parse(deleted.stdout).entries[0].kind).toBe("deleted");
  await git(opts.cwd, "add", "-u");
  await git(
    opts.cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "delete",
  );
  const clean = await runApp(app, ["ready", "posts", "--changed", "--yes", "--json"], opts);
  expect(clean.code).toBe(0);
  expect(JSON.parse(clean.stdout).status).toBe("noop");
  await absent(opts.env.XDG_STATE_HOME);
  expect((await runApp(app, ["ready", "missing", "--changed", "--json"], opts)).code).toBe(1);
});
test("changed outside Git gives actionable one-object JSON", async () => {
  const opts = await setup();
  const result = await runApp(app, ["ready", "--changed", "--json"], opts);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain("Git working tree");
});

test("confirmation sees the complete plan; refusal, cancellation and confirmation-time edits write nothing", async () => {
  for (const scenario of ["decline", "abort", "edit"] as const) {
    const opts = await setup();
    await image(join(opts.cwd, "input.png"));
    const stderr = capture();
    const controller = new AbortController();
    let prompted = false;
    const interactive = createApp(sv, {
      context(base, intent) {
        return {
          ...createContext(base, intent),
          async confirm() {
            prompted = true;
            expect(stderr.text).toContain("Create image:");
            expect(stderr.text).toContain("Create review:");
            await absent(join(opts.cwd, ".sv-ready"));
            await absent(opts.env.XDG_STATE_HOME);
            if (scenario === "abort") controller.abort();
            if (scenario === "edit")
              await writeFile(join(opts.cwd, "input.png"), "changed during confirmation");
            return scenario !== "decline";
          },
        };
      },
    });
    const result = await runApp(interactive, ["ready", "input.png", "--apply", "--review"], {
      ...opts,
      stderr,
      signal: controller.signal,
    });
    expect(result.code).toBe(1);
    expect(prompted).toBe(true);
    await absent(join(opts.cwd, ".sv-ready"));
    await absent(opts.env.XDG_STATE_HOME);
  }
});
test("existing targets are preserved; apply refuses a destination created after preview", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "input.png"));
  await mkdir(join(opts.cwd, ".sv-ready"));
  await writeFile(join(opts.cwd, ".sv-ready/input.webp"), "existing");
  const plan = await planReady(await inspectReady(["input.png"], opts));
  expect(plan.actions[0]!.destination).toBe(join(opts.cwd, ".sv-ready/input-1.webp"));
  await writeFile(plan.actions[0]!.destination, "racing writer");
  await expect(applyReady(plan)).rejects.toThrow("Destination exists");
  expect(await readFile(plan.actions[0]!.destination, "utf8")).toBe("racing writer");
  expect(await readFile(join(opts.cwd, ".sv-ready/input.webp"), "utf8")).toBe("existing");
  await absent(opts.env.XDG_STATE_HOME);
});
test("same-format images skip by default and explicit quality reencodes; AVIF is recognized", async () => {
  const opts = await setup();
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
  for (const format of ["webp", "avif"] as const) {
    const path = join(opts.cwd, `input.${format}`);
    await sharp(png).toFormat(format).toFile(path);
    const plan = await planReady(await inspectReady([path], { ...opts, format }));
    expect(plan.actions).toHaveLength(0);
    expect(plan.entries[0]!.status).toBe("skipped");
    const encoded = await planReady(await inspectReady([path], { ...opts, format, quality: 70 }));
    expect(encoded.actions).toHaveLength(1);
  }
});
test("unsupported SVG is classified; oversized input and symlinks are blocking", async () => {
  const opts = await setup();
  await writeFile(
    join(opts.cwd, "input.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  );
  const unsupported = await planReady(await inspectReady(["input.svg"], opts));
  expect(unsupported.entries[0]!.status).toBe("unsupported");
  expect(unsupported.actions).toHaveLength(0);
  const { truncate, symlink } = await import("node:fs/promises");
  await writeFile(join(opts.cwd, "large.png"), "");
  await truncate(join(opts.cwd, "large.png"), 12 * 1024 * 1024 + 1);
  const large = await planReady(await inspectReady(["large.png"], opts));
  expect(large.failures).toHaveLength(1);
  await symlink(join(opts.cwd, "input.svg"), join(opts.cwd, "link.svg"));
  const link = await planReady(await inspectReady(["link.svg"], opts));
  expect(link.failures).toHaveLength(1);
  await expect(applyReady(large)).rejects.toThrow("no files written");
  await absent(opts.env.XDG_STATE_HOME);
});

test("video inspection suggests a separate conversion with a fixture probe", async () => {
  const opts = await setup();
  const bin = join(opts.cwd, "fake-bin");
  await mkdir(bin);
  const { chmod } = await import("node:fs/promises");
  await writeFile(
    join(bin, "ffprobe"),
    '#!/bin/sh\nprintf \'%s\' \'{"streams":[{"codec_type":"video","codec_name":"h264","width":16,"height":8}],"format":{"duration":"1","size":"8"}}\'\n',
  );
  await chmod(join(bin, "ffprobe"), 0o755);
  await writeFile(join(opts.cwd, "clip.mp4"), "fixture");
  const result = await runApp(app, ["ready", "clip.mp4", "--yes", "--json"], {
    ...opts,
    env: { ...opts.env, PATH: bin },
  });
  expect(result.code).toBe(0);
  const data = JSON.parse(result.stdout);
  expect(data.entries[0].status).toBe("unsupported");
  expect(data.entries[0].suggestions[0]).toEqual(["video", "webm", join(opts.cwd, "clip.mp4"), "--dry-run"]);
  expect(data.actions).toHaveLength(0);
  await absent(opts.env.XDG_STATE_HOME);
});

test("review source dimensions reflect EXIF orientation", async () => {
  const opts = await setup();
  const input = join(opts.cwd, "rotated.jpg");
  await sharp({ create: { width: 40, height: 20, channels: 3, background: "red" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(input);
  const plan = await planReady(await inspectReady([input], { ...opts, review: true, width: 16 }));
  expect(plan.failures).toHaveLength(0);
  const report = plan.operations.find((op) => op.path.endsWith(".html"));
  const html = Buffer.from(report!.bytes).toString("utf8");
  const data = JSON.parse(html.match(/type="application\/json">([\s\S]*?)<\/script>/)![1]!);
  expect(data.source).toMatchObject({ width: 20, height: 40 });
  expect(data.reference).toMatchObject({ width: 16, height: 32 });
  expect(data.variants[0]).toMatchObject({ width: 16, height: 32 });
  await absent(join(opts.cwd, ".sv-ready"));
});

test("ordinary Markdown does not require blog frontmatter, but broken content blocks all writes", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "hero.png"));
  await writeFile(join(opts.cwd, "README.md"), "# Project\nA useful project.\n");
  const clean = await runApp(app, ["ready", ".", "--json"], opts);
  expect(clean.code).toBe(0);
  expect(JSON.parse(clean.stdout)).toMatchObject({
    status: "planned",
    checks: { files: 1, errors: 0, ok: true },
  });
  await writeFile(join(opts.cwd, "README.md"), "# Project\n[broken](absent.md)\n");
  const blocked = await runApp(app, ["ready", ".", "--yes", "--json"], opts);
  expect(blocked.code).toBe(1);
  expect(JSON.parse(blocked.stdout).status).toBe("blocked");
  expect(JSON.parse(blocked.stdout).failures.join("\n")).toContain("broken-link");
  await absent(join(opts.cwd, ".sv-ready"));
  await absent(opts.env.XDG_STATE_HOME);
});

test("configured blogs enforce metadata while warnings are nonblocking", async () => {
  const opts = await setup();
  await writeFile(join(opts.cwd, "sv.blog.json"), JSON.stringify({ requiredMetadata: ["title"] }));
  await writeFile(join(opts.cwd, "post.md"), "# Post\n");
  const missing = await runApp(app, ["ready", "post.md", "--json"], opts);
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.stdout).checks).toMatchObject({ errors: 1, ok: false });
  await writeFile(join(opts.cwd, "post.md"), "---\ntitle: Post\n---\nCurly “quotes”\n");
  const warnings = await runApp(app, ["ready", "post.md", "--json"], opts);
  expect(warnings.code).toBe(0);
  expect(JSON.parse(warnings.stdout).checks).toMatchObject({ errors: 0, ok: true });
  expect(JSON.parse(warnings.stdout).checks.warnings).toBeGreaterThan(0);
});

test("human preview is readable and its next command retains --cwd and encoding settings", async () => {
  const opts = await setup();
  await image(join(opts.cwd, "hero image.png"));
  const result = await runApp(
    app,
    ["--cwd", opts.cwd, "ready", "hero image.png", "--quality", "70", "--review"],
    opts,
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("Ready preview: 1 file · 2 outputs");
  expect(result.stderr).toContain('Create image: ".sv-ready/hero image.webp"');
  expect(result.stderr).not.toContain("Suggested argv");
  expect(result.stdout).toContain("Preview only; originals are preserved.");
  expect(result.stdout).toContain("--quality 70");
  expect(result.stdout).toContain("--review");
  expect(result.stdout).toContain("--apply");
  expect(result.stdout).toContain(`--cwd ${opts.cwd}`);
});
