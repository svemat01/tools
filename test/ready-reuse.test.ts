import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import sharp from "sharp";

import { contentHash, readHistory, undoOperation } from "../src/lib/operations.ts";
import type { ProgressEvent } from "../src/lib/progress.ts";
import { applyReady, inspectReady, planReady, type ReadyOptions } from "../src/lib/ready.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sv-ready-reuse-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  const options: ReadyOptions = { cwd, env: {}, stateRoot: join(root, "state") };
  await image(join(cwd, "input.png"));
  return options;
}
async function image(path: string, background = "red") {
  await mkdir(dirname(path), { recursive: true });
  await sharp({ create: { width: 16, height: 12, channels: 3, background } })
    .png()
    .toFile(path);
}
async function plan(options: ReadyOptions, targets = ["input.png"]) {
  return planReady(await inspectReady(targets, options));
}
async function receiptPath(options: ReadyOptions, id: string) {
  return join(options.stateRoot!, contentHash(Buffer.from(await realpath(options.cwd))), id, "receipt.json");
}

test("repeat application reuses verified images and reviews without encoding or creating another receipt", async () => {
  const options = { ...(await setup()), review: true };
  const first = await plan(options);
  const receipt = await applyReady(first);
  expect(receipt?.status).toBe("applied");
  const state = await readFile(await receiptPath(options, receipt!.id), "utf8");
  const outputs = await readdir(join(options.cwd, ".sv-ready"));
  const events: ProgressEvent[] = [];
  const next = await plan({ ...options, onProgress: (event) => events.push(event) });
  expect(next.actions).toHaveLength(0);
  expect(next.operations).toHaveLength(0);
  expect(next.reused.map((item) => item.kind)).toEqual(["image", "review"]);
  expect(next.entries[0]?.status).toBe("reused");
  expect(events.some((event) => event.phase === "encode" || event.phase === "review")).toBe(false);
  expect(await applyReady(next)).toBeNull();
  expect(await readHistory(options)).toHaveLength(1);
  expect(await readdir(join(options.cwd, ".sv-ready"))).toEqual(outputs);
  expect(await readFile(await receiptPath(options, receipt!.id), "utf8")).toBe(state);
});

test("preview neither creates missing state nor mutates receipts or outputs", async () => {
  const options = await setup();
  const first = await plan(options);
  expect(first.actions).toHaveLength(1);
  expect(await Bun.file(options.stateRoot!).exists()).toBe(false);
  expect(await Bun.file(join(options.cwd, ".sv-ready")).exists()).toBe(false);
  const receipt = await applyReady(first);
  const before = await readFile(await receiptPath(options, receipt!.id), "utf8");
  expect((await plan(options)).reused).toHaveLength(1);
  expect(await readFile(await receiptPath(options, receipt!.id), "utf8")).toBe(before);
});

test("adding review reuses image independently and undoing that review retains the prior image", async () => {
  const options = await setup();
  const first = await applyReady(await plan(options));
  const reviewed = await plan({ ...options, review: true });
  expect(reviewed.reused.map((item) => item.kind)).toEqual(["image"]);
  expect(reviewed.actions.map((item) => item.kind)).toEqual(["review"]);
  const second = await applyReady(reviewed);
  expect(second?.files).toHaveLength(1);
  expect(second?.files[0]?.recipeHash).toBeString();
  expect((await plan({ ...options, review: true })).reused).toHaveLength(2);
  await undoOperation(second!.id, options);
  const afterUndo = await plan({ ...options, review: true });
  expect(afterUndo.reused.map((item) => item.kind)).toEqual(["image"]);
  expect(afterUndo.reused[0]?.recordId).toBe(first!.id);
  expect(afterUndo.actions.map((item) => item.kind)).toEqual(["review"]);
});

test("different settings and output scope do not reuse prior preparation", async () => {
  const options = await setup();
  await applyReady(await plan(options));
  for (const changed of [
    { width: 8 },
    { quality: 82 },
    { quality: 30 },
    { format: "avif" as const },
    { outDir: "other" },
  ]) {
    const next = await plan({ ...options, ...changed });
    expect(next.reused).toHaveLength(0);
    expect(next.actions).toHaveLength(1);
  }
});

test("changed sources and edited outputs are never overwritten as reuse", async () => {
  const options = await setup();
  const first = await plan(options);
  await applyReady(first);
  const output = first.actions[0]!.destination;
  await writeFile(output, "user edit");
  const edited = await plan(options);
  expect(edited.reused).toHaveLength(0);
  expect(edited.actions[0]!.destination).not.toBe(output);
  expect(await readFile(output, "utf8")).toBe("user edit");
  await image(join(options.cwd, "input.png"), "blue");
  const changed = await plan(options);
  expect(changed.reused).toHaveLength(0);
  expect(changed.actions).toHaveLength(1);
});

test("deleted output and undone receipts cannot authorize reuse", async () => {
  const options = await setup();
  const first = await plan(options);
  const receipt = await applyReady(first);
  const original = await readFile(first.actions[0]!.destination);
  await undoOperation(receipt!.id, options);
  await writeFile(first.actions[0]!.destination, original);
  const undone = await plan(options);
  expect(undone.reused).toHaveLength(0);
  expect(undone.actions[0]!.destination).not.toBe(first.actions[0]!.destination);
  await rm(first.actions[0]!.destination);
  expect((await plan(options)).actions[0]!.destination).toBe(first.actions[0]!.destination);
});

test("reused dependencies are revalidated before any new mutation", async () => {
  const options = await setup();
  await applyReady(await plan(options));
  await image(join(options.cwd, "new.png"));
  const next = await plan(options, ["input.png", "new.png"]);
  expect(next.reused).toHaveLength(1);
  expect(next.actions).toHaveLength(1);
  await writeFile(next.reused[0]!.destination, "edited after preview");
  await expect(applyReady(next)).rejects.toThrow("Reused output changed");
  expect(await Bun.file(next.actions[0]!.destination).exists()).toBe(false);
  expect(await readHistory(options)).toHaveLength(1);
});

test("receipt status changes invalidate an already-built reuse plan", async () => {
  const options = await setup();
  const first = await applyReady(await plan(options));
  const next = await plan(options);
  const path = await receiptPath(options, first!.id);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.status = "undone";
  receipt.files[0].status = "undone";
  await writeFile(path, JSON.stringify(receipt));
  await expect(applyReady(next)).rejects.toThrow("no longer applied");
});

test("duplicate basenames remain independently reusable and legacy receipts are ignored", async () => {
  const options = await setup();
  await image(join(options.cwd, "a/same.png"));
  await image(join(options.cwd, "b/same.png"));
  const targets = ["a", "b"];
  const first = await plan(options, targets);
  const receipt = await applyReady(first);
  const next = await plan(options, targets);
  expect(next.reused).toHaveLength(2);
  expect(new Set(next.reused.map((item) => item.destination)).size).toBe(2);
  const path = await receiptPath(options, receipt!.id);
  const legacy = JSON.parse(await readFile(path, "utf8"));
  for (const file of legacy.files) delete file.recipeHash;
  await writeFile(path, JSON.stringify(legacy));
  const old = await plan(options, targets);
  expect(old.reused).toHaveLength(0);
  expect(old.actions).toHaveLength(2);
});

test("a stale reused source blocks new outputs before content or receipt mutations", async () => {
  const options = await setup();
  await applyReady(await plan(options));
  await image(join(options.cwd, "new.png"));
  const next = await plan(options, ["input.png", "new.png"]);
  await image(join(options.cwd, "input.png"), "green");
  await expect(applyReady(next)).rejects.toThrow("Input changed since reuse planning");
  expect(await Bun.file(next.actions[0]!.destination).exists()).toBe(false);
  expect(await readHistory(options)).toHaveLength(1);
});

test("only applied file statuses from a partial receipt are reusable", async () => {
  const options = await setup();
  await image(join(options.cwd, "new.png"));
  const targets = ["input.png", "new.png"];
  const first = await applyReady(await plan(options, targets));
  const path = await receiptPath(options, first!.id);
  const receipt = JSON.parse(await readFile(path, "utf8"));
  receipt.status = "partial";
  receipt.files[1].status = "applying";
  await writeFile(path, JSON.stringify(receipt));
  const next = await plan(options, targets);
  expect(next.reused).toHaveLength(1);
  expect(next.actions).toHaveLength(1);
  expect(next.reused[0]!.source).toBe(join(options.cwd, "input.png"));
});
