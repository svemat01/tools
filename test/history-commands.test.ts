import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { app } from "../src/app.ts";
import { runApp } from "./support/io.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sv-history-cli-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  return { cwd, env: { XDG_STATE_HOME: join(root, "state") } };
}
test("history read is side effect free and scopes by cwd", async () => {
  const opts = await setup();
  const result = await runApp(app, ["history", "--json"], opts);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([]);
  expect(await stat(opts.env.XDG_STATE_HOME).catch(() => null)).toBeNull();
  expect((await runApp(app, ["history", "unknown"], opts)).code).toBe(1);
});
test("img web recording exposes receipt; JSON undo requires --yes and dry-run never mutates", async () => {
  const opts = await setup();
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
    .png()
    .toFile(join(opts.cwd, "input.png"));
  const source = await readFile(join(opts.cwd, "input.png"));
  const converted = await runApp(app, ["img", "web", "input.png", "--record", "--json"], opts);
  expect(converted.code).toBe(0);
  const { recordId } = JSON.parse(converted.stdout);
  expect(typeof recordId).toBe("string");
  const history = await runApp(app, ["history", recordId, "--json"], opts);
  expect(JSON.parse(history.stdout)).toMatchObject({ id: recordId, status: "applied", version: 1 });
  const preview = await runApp(app, ["undo", "last", "--dry-run", "--json"], opts);
  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.stdout).dryRun).toBe(true);
  expect((await runApp(app, ["undo", "last", "--json"], opts)).code).toBe(1);
  expect(await Bun.file(join(opts.cwd, "input.webp")).exists()).toBe(true);
  const undone = await runApp(app, ["undo", recordId, "--yes", "--json"], opts);
  expect(undone.code).toBe(0);
  expect(JSON.parse(undone.stdout).receipt.status).toBe("undone");
  expect(await Bun.file(join(opts.cwd, "input.webp")).exists()).toBe(false);
  expect(await readFile(join(opts.cwd, "input.png"))).toEqual(source);
});
test("recorded force restores target and changed sources refuse undo", async () => {
  const opts = await setup();
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } })
    .png()
    .toFile(join(opts.cwd, "input.png"));
  await writeFile(join(opts.cwd, "target.webp"), "old target");
  const result = await runApp(
    app,
    ["img", "web", "input.png", "--out", "target.webp", "--force", "--record", "--json"],
    opts,
  );
  expect(result.code).toBe(0);
  const id = JSON.parse(result.stdout).recordId;
  const original = await readFile(join(opts.cwd, "input.png"));
  await writeFile(join(opts.cwd, "input.png"), "changed");
  expect((await runApp(app, ["undo", id, "--yes"], opts)).code).toBe(1);
  await writeFile(join(opts.cwd, "input.png"), original);
  expect((await runApp(app, ["undo", id, "--yes"], opts)).code).toBe(0);
  expect(await readFile(join(opts.cwd, "target.webp"), "utf8")).toBe("old target");
});
test("record dry-run and plain img web never create history", async () => {
  const opts = await setup();
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
    .png()
    .toFile(join(opts.cwd, "input.png"));
  expect((await runApp(app, ["img", "web", "input.png", "--record", "--dry-run", "--json"], opts)).code).toBe(
    0,
  );
  expect(await stat(opts.env.XDG_STATE_HOME).catch(() => null)).toBeNull();
  expect((await runApp(app, ["img", "web", "input.png", "--json"], opts)).code).toBe(0);
  expect(await stat(opts.env.XDG_STATE_HOME).catch(() => null)).toBeNull();
});
