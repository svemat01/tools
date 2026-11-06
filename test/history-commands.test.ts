import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { app, sv } from "../src/app.ts";
import { createContext } from "../src/context.ts";
import { createApp } from "../src/kit/index.ts";
import { contentHash, executeFilePlan } from "../src/lib/operations.ts";
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

test("empty human history explains how to record operations without creating state", async () => {
  const opts = await setup();
  const result = await runApp(app, ["history"], opts);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`History: ${JSON.stringify(await realpath(opts.cwd))}`);
  expect(result.stdout).toContain("No recorded operations in this directory");
  expect(result.stdout).toContain("--record");
  expect(result.stdout).toContain("sv ready");
  expect(await stat(opts.env.XDG_STATE_HOME).catch(() => null)).toBeNull();
});

test("history last selects the latest receipt and human output guides undo", async () => {
  const opts = await setup();
  const receipt = await executeFilePlan(
    [{ kind: "create", path: "result.txt", bytes: Buffer.from("result") }],
    opts,
  );
  const last = await runApp(app, ["history", "last", "--json"], opts);
  expect(last.code).toBe(0);
  expect(JSON.parse(last.stdout).id).toBe(receipt.id);
  const history = await runApp(app, ["history"], opts);
  expect(history.stdout).toContain("undo last --dry-run");
  expect(history.stdout).toContain(`--cwd ${opts.cwd}`);
});

test("undo preview does not claim pending journal publications changed a file", async () => {
  for (const kind of ["create", "replace"] as const) {
    const opts = await setup();
    const path = join(opts.cwd, "result.txt");
    if (kind === "replace") await writeFile(path, "original");
    const receipt = await executeFilePlan(
      [
        kind === "create"
          ? { kind, path, bytes: Buffer.from("new") }
          : { kind, path, bytes: Buffer.from("new"), expected: Buffer.from("original") },
      ],
      opts,
    );
    if (kind === "create") await unlink(path);
    else await writeFile(path, "original");
    receipt.status = "partial";
    receipt.files[0]!.status = "applying";
    const receiptPath = join(
      opts.env.XDG_STATE_HOME,
      "sv",
      contentHash(Buffer.from(await realpath(opts.cwd))),
      receipt.id,
      "receipt.json",
    );
    await writeFile(receiptPath, JSON.stringify(receipt));
    const command = createApp(sv, {
      context(base, intent) {
        return {
          ...createContext(base, intent),
          async confirm() {
            throw new Error("Empty undo should not prompt");
          },
        };
      },
    });
    const readOnlyPreview = await runApp(command, ["undo", receipt.id, "--dry-run", "--json"], opts);
    expect(readOnlyPreview.code).toBe(0);
    expect(JSON.parse(readOnlyPreview.stdout).changes).toEqual([]);
    expect(JSON.parse(await readFile(receiptPath, "utf8")).status).toBe("partial");
    const preview = await runApp(command, ["undo", receipt.id], opts);
    expect(preview.code).toBe(0);
    expect(preview.stdout).toContain("0 file changes");
    expect(preview.stdout).toContain("Nothing to undo");
    expect(preview.stdout).not.toContain(`  ${kind === "create" ? "delete" : "restore"}`);
    const jsonPreview = await runApp(command, ["undo", receipt.id, "--dry-run", "--json"], opts);
    expect(JSON.parse(jsonPreview.stdout).changes).toEqual([]);
    expect(JSON.parse(await readFile(receiptPath, "utf8")).status).toBe("undone");
  }
});
