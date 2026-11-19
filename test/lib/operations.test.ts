import { afterEach, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { contentHash, executeFilePlan, readHistory, undoOperation } from "../../src/lib/operations.ts";

const roots: string[] = [];
const bytes = (text: string) => Buffer.from(text);
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "sv-operations-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  return { cwd, stateRoot: join(root, "state"), env: { HOME: root, PRIVATE_SECRET: "not recorded" } };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("create and replace roundtrip, private durable metadata, no output backup duplication", async () => {
  const opts = await setup();
  const path = join(opts.cwd, "document");
  await writeFile(path, "old");
  await chmod(path, 0o640);
  const receipt = await executeFilePlan(
    [
      { kind: "create", path: "new", bytes: bytes("new") },
      { kind: "replace", path, expected: bytes("old"), bytes: bytes("replacement") },
    ],
    opts,
  );
  expect(receipt.status).toBe("applied");
  expect((await stat(path)).mode & 0o777).toBe(0o640);
  const partition = (await readdir(opts.stateRoot))[0]!;
  const directory = join(opts.stateRoot, partition, receipt.id);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(join(directory, "receipt.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(directory, "1.bak"))).mode & 0o777).toBe(0o600);
  expect((await readdir(directory)).sort()).toEqual(["1.bak", "receipt.json"]);
  expect(await readFile(join(directory, "receipt.json"), "utf8")).not.toContain("not recorded");
  expect((await undoOperation(receipt.id, { ...opts, dryRun: true })).status).toBe("applied");
  expect(await readFile(path, "utf8")).toBe("replacement");
  expect((await undoOperation(receipt.id, opts)).status).toBe("undone");
  expect(await readFile(path, "utf8")).toBe("old");
  expect((await stat(path)).mode & 0o777).toBe(0o640);
  expect(await Bun.file(join(opts.cwd, "new")).exists()).toBe(false);
});

test("entire plan conflicts refuse before writing content or state", async () => {
  const opts = await setup();
  await writeFile(join(opts.cwd, "existing"), "old");
  await expect(
    executeFilePlan(
      [
        { kind: "create", path: "new", bytes: bytes("a") },
        { kind: "replace", path: "existing", expected: bytes("wrong"), bytes: bytes("b") },
      ],
      opts,
    ),
  ).rejects.toThrow("changed");
  await expect(
    executeFilePlan(
      [
        { kind: "create", path: "new", bytes: bytes("a") },
        { kind: "create", path: "./new", bytes: bytes("b") },
      ],
      opts,
    ),
  ).rejects.toThrow("Duplicate");
  await expect(
    executeFilePlan(
      [
        { kind: "replace", path: "existing", expected: contentHash(bytes("old")), bytes: bytes("b") },
        {
          kind: "create",
          path: "new",
          bytes: bytes("b"),
          inputs: [{ path: "existing", hash: contentHash(bytes("old")) }],
        },
      ],
      opts,
    ),
  ).rejects.toThrow("Input conflicts");
  expect(await Bun.file(join(opts.cwd, "new")).exists()).toBe(false);
  expect(await readHistory(opts)).toEqual([]);
  expect(await stat(opts.stateRoot).catch(() => null)).toBeNull();
});

test("receipt directories left before journaling do not hide recorded operations", async () => {
  const opts = await setup();
  const receipt = await executeFilePlan([{ kind: "create", path: "result", bytes: bytes("new") }], opts);
  const [partition] = await readdir(opts.stateRoot);
  const interrupted = join(opts.stateRoot, partition!, randomUUID());
  await mkdir(interrupted);
  await writeFile(join(interrupted, "0.bak"), "backup staged before receipt");

  expect((await readHistory(opts)).map((item) => item.id)).toEqual([receipt.id]);
  expect((await readHistory(opts, { limit: 1, maxBytes: 4096 })).map((item) => item.id)).toEqual([
    receipt.id,
  ]);
  expect((await undoOperation("last", opts)).status).toBe("undone");
});

test("undo refuses a receipt that advanced since preview", async () => {
  const opts = await setup();
  const output = join(opts.cwd, "result");
  const applied = await executeFilePlan([{ kind: "create", path: output, bytes: bytes("new") }], opts);
  const [partition] = await readdir(opts.stateRoot);
  const receiptPath = join(opts.stateRoot, partition!, applied.id, "receipt.json");
  const preparing = {
    ...applied,
    status: "prepared",
    files: [{ ...applied.files[0], status: "pending" }],
  };
  await writeFile(receiptPath, JSON.stringify(preparing));
  const preview = await undoOperation(applied.id, { ...opts, dryRun: true });
  await writeFile(receiptPath, JSON.stringify(applied));

  await expect(undoOperation(applied.id, { ...opts, expectedReceipt: preview })).rejects.toThrow(
    "Operation changed since the undo preview",
  );
  expect(await readFile(output, "utf8")).toBe("new");
});

test("undo preflights all outputs, inputs and backup integrity", async () => {
  const opts = await setup();
  await writeFile(join(opts.cwd, "old"), "old");
  await writeFile(join(opts.cwd, "source"), "source");
  const receipt = await executeFilePlan(
    [
      {
        kind: "create",
        path: "new",
        bytes: bytes("new"),
        inputs: [{ path: "source", hash: contentHash(bytes("source")) }],
      },
      { kind: "replace", path: "old", expected: bytes("old"), bytes: bytes("after") },
    ],
    opts,
  );
  await writeFile(join(opts.cwd, "old"), "edited");
  await expect(undoOperation(receipt.id, opts)).rejects.toThrow("Output changed");
  expect(await Bun.file(join(opts.cwd, "new")).exists()).toBe(true);
  await writeFile(join(opts.cwd, "old"), "after");
  await writeFile(join(opts.cwd, "source"), "changed");
  await expect(undoOperation(receipt.id, opts)).rejects.toThrow("Input changed");
  await writeFile(join(opts.cwd, "source"), "source");
  const partition = (await readdir(opts.stateRoot))[0]!;
  await writeFile(join(opts.stateRoot, partition, receipt.id, "1.bak"), "corrupt");
  await expect(undoOperation(receipt.id, opts)).rejects.toThrow("Backup corrupt");
  expect(await Bun.file(join(opts.cwd, "new")).exists()).toBe(true);
});

test("partial cancellation persists completed operations and permits cautious undo", async () => {
  const opts = await setup();
  const signal = new AbortController().signal;
  let checks = 0;
  const spy = spyOn(signal, "throwIfAborted").mockImplementation(() => {
    if (++checks === 5) throw new Error("cancelled");
  });
  const receipt = await executeFilePlan(
    [
      { kind: "create", path: "a", bytes: bytes("a") },
      { kind: "create", path: "b", bytes: bytes("b") },
    ],
    { ...opts, signal },
  );
  spy.mockRestore();
  expect(receipt.status).toBe("partial");
  expect(receipt.files.map((file) => file.status)).toEqual(["applied", "pending"]);
  expect((await readHistory(opts))[0]!.error).toBe("cancelled");
  expect((await undoOperation(receipt.id, opts)).status).toBe("undone");
});

test("concurrent plans have distinct receipts; canonical cwd aliases share history", async () => {
  const opts = await setup();
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      executeFilePlan([{ kind: "create", path: `file${index}`, bytes: bytes("a") }], opts),
    ),
  );
  expect(new Set(results.map((r) => r.id)).size).toBe(5);
  expect(results.every((r) => r.status === "applied")).toBe(true);
  const alias = join(opts.cwd, "../alias");
  await symlink(opts.cwd, alias);
  expect((await readHistory({ ...opts, cwd: alias })).length).toBe(5);
});

test("symlinks and aborted requests fail closed", async () => {
  const opts = await setup();
  await writeFile(join(opts.cwd, "original"), "old");
  await symlink("original", join(opts.cwd, "alias"));
  await expect(
    executeFilePlan([{ kind: "replace", path: "alias", expected: bytes("old"), bytes: bytes("new") }], opts),
  ).rejects.toThrow("Symlink");
  await expect(executeFilePlan([], { ...opts, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(await readFile(join(opts.cwd, "original"), "utf8")).toBe("old");
});

test.each([
  ["unrelated", "Output changed"],
  ["b", "Unconfirmed publication"],
])("publication failure preserves a racing file containing %s during undo", async (racingBytes, error) => {
  const opts = await setup();
  const racingFile = join(opts.cwd, "b");
  const receipt = await executeFilePlan(
    [
      { kind: "create", path: "a", bytes: bytes("a") },
      { kind: "create", path: "b", bytes: bytes("b") },
    ],
    {
      ...opts,
      onProgress(event) {
        if (event.path === racingFile) writeFileSync(racingFile, racingBytes, { flag: "wx" });
      },
    },
  );
  expect(receipt.status).toBe("partial");
  expect(receipt.files[0]!.status).toBe("applied");
  expect(receipt.files[1]!.status).toBe("applying");
  await expect(undoOperation(receipt.id, opts)).rejects.toThrow(error);
  expect(await readFile(racingFile, "utf8")).toBe(racingBytes);
  expect(await Bun.file(join(opts.cwd, "a")).exists()).toBe(true);
});
