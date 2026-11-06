/** Explicit file plans only: no argv, environment, stdin or implicit content capture. */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { z } from "zod";

import { writeFileAtomic } from "./fs.ts";

export const contentHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export interface FileInput {
  readonly path: string;
  readonly hash: string;
}
interface FileOutput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly inputs?: readonly FileInput[];
}
export type FileOperation = FileOutput &
  ({ readonly kind: "create" } | { readonly kind: "replace"; readonly expected: Uint8Array | string });
export interface OperationOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly projectRoot?: string;
  /** Exact sv state root; intended for embedders/tests. */
  readonly stateRoot?: string;
  readonly signal?: AbortSignal;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema = z.object({
  kind: z.enum(["create", "replace"]),
  path: z.string(),
  afterHash: hash,
  beforeHash: hash.optional(),
  mode: z.number().int().optional(),
  backup: z
    .string()
    .regex(/^\d+\.bak$/)
    .optional(),
  inputs: z.array(z.object({ path: z.string(), hash })),
  status: z.enum(["pending", "applying", "applied", "undoing", "undone"]),
});
const receiptSchema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  project: z.string(),
  cwd: z.string(),
  status: z.enum(["prepared", "applying", "applied", "partial", "undoing", "undone"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  files: z.array(fileSchema),
  error: z.string().optional(),
});
export type OperationReceipt = z.infer<typeof receiptSchema>;
type ReceiptFile = OperationReceipt["files"][number];
const now = (): string => new Date().toISOString();
const missing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
async function info(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!missing(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), path.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
  }
}
async function location(options: OperationOptions) {
  const cwd = await realpath(options.cwd);
  const project = await realpath(resolve(cwd, options.projectRoot ?? "."));
  const root =
    options.stateRoot ??
    (options.env.XDG_STATE_HOME
      ? join(options.env.XDG_STATE_HOME, "sv")
      : join(options.env.HOME ?? homedir(), ".local/state/sv"));
  if (!isAbsolute(root)) throw new Error("State root must be absolute");
  return { cwd, project, directory: join(root, contentHash(Buffer.from(project))) };
}
async function privateDirectory(path: string): Promise<void> {
  const firstCreated = await mkdir(path, { recursive: true, mode: 0o700 });
  if (firstCreated) {
    for (let current = path; ; current = dirname(current)) {
      const parent = await open(dirname(current), "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
      if (current === firstCreated) break;
    }
  }
  const entry = await lstat(path);
  if (!entry.isDirectory() || (entry.mode & 0o077) !== 0 || entry.uid !== process.getuid?.()) {
    throw new Error(`State directory must be private and owned by this user: ${path}`);
  }
}
async function locked<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(directory);
  const path = join(directory, "lock");
  let handle;
  for (let attempt = 0; ; attempt++) {
    try {
      handle = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST") || attempt >= 80) {
        throw new Error(`History busy or interrupted; inspect and remove stale lock: ${path}`, {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await action();
  } finally {
    await handle.close();
    await unlink(path);
  }
}
async function save(directory: string, receipt: OperationReceipt): Promise<void> {
  receipt.updatedAt = now();
  await writeFileAtomic(join(directory, "receipt.json"), Buffer.from(JSON.stringify(receipt, null, 2)), {
    overwrite: true,
    mode: 0o600,
    durable: true,
  });
}
async function regularBytes(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error(`Not a regular file: ${path}`);
  return readFile(path);
}
async function checkInputs(inputs: readonly FileInput[]): Promise<void> {
  for (const input of inputs)
    if (contentHash(await regularBytes(input.path)) !== input.hash)
      throw new Error(`Input changed: ${input.path}`);
}

/** Preflight the whole plan, durably journal intent/backups, then publish sequentially.
 * Returns a partial receipt on application failure; preflight failures throw without mutations.
 */
export async function executeFilePlan(
  plan: readonly FileOperation[],
  options: OperationOptions,
): Promise<OperationReceipt> {
  options.signal?.throwIfAborted();
  // Snapshot caller-owned buffers before any asynchronous work can change them.
  const operations = plan.map((op) => ({
    ...op,
    bytes: Buffer.from(op.bytes),
    inputs: op.inputs?.map((input) => ({ ...input })) ?? [],
    ...(op.kind === "replace" && typeof op.expected !== "string"
      ? { expected: Buffer.from(op.expected) }
      : {}),
  }));
  const loc = await location(options);
  const files: ReceiptFile[] = [];
  const backups: Buffer[] = [];
  const destinations = new Set<string>();
  for (const op of operations) {
    const path = await canonical(resolve(loc.cwd, op.path));
    // A symlink destination must never be interpreted as replacement permission.
    const originalPath = resolve(loc.cwd, op.path);
    if ((await info(originalPath))?.isSymbolicLink()) throw new Error(`Symlink destination: ${originalPath}`);
    if (destinations.has(path)) throw new Error(`Duplicate destination: ${path}`);
    if (
      [...destinations].some(
        (other) => path.startsWith(`${other}${sep}`) || other.startsWith(`${path}${sep}`),
      )
    )
      throw new Error(`Overlapping destinations: ${path}`);
    destinations.add(path);
    const existing = await info(path);
    if (op.kind === "create" && existing) throw new Error(`Destination exists: ${path}`);
    const inputs = await Promise.all(
      (op.inputs ?? []).map(async (input) => ({
        path: await realpath(resolve(loc.cwd, input.path)),
        hash: input.hash,
      })),
    );
    await checkInputs(inputs);
    const file: ReceiptFile = {
      kind: op.kind,
      path,
      afterHash: contentHash(op.bytes),
      inputs,
      status: "pending",
    };
    if (op.kind === "replace") {
      const before = await regularBytes(path);
      if (contentHash(before) !== (typeof op.expected === "string" ? op.expected : contentHash(op.expected)))
        throw new Error(`Replacement changed: ${path}`);
      file.beforeHash = contentHash(before);
      file.mode = existing!.mode & 0o7777;
      file.backup = `${files.length}.bak`;
      backups[files.length] = before;
    }
    files.push(file);
  }
  for (const file of files)
    for (const input of file.inputs) {
      if (destinations.has(input.path) && !(file.kind === "replace" && input.path === file.path))
        throw new Error(`Input conflicts with destination: ${input.path}`);
    }
  options.signal?.throwIfAborted();
  return locked(loc.directory, async () => {
    options.signal?.throwIfAborted();
    const id = randomUUID();
    const directory = join(loc.directory, id);
    await privateDirectory(directory);
    const receipt: OperationReceipt = {
      version: 1,
      id,
      project: loc.project,
      cwd: loc.cwd,
      status: "prepared",
      createdAt: now(),
      updatedAt: now(),
      files,
    };
    for (const [index, file] of files.entries())
      if (file.backup)
        await writeFileAtomic(join(directory, file.backup), backups[index]!, { mode: 0o600, durable: true });
    await save(directory, receipt);
    const parent = await open(loc.directory, "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    try {
      receipt.status = "applying";
      for (const [index, file] of files.entries()) {
        options.signal?.throwIfAborted();
        await checkInputs(file.inputs);
        file.status = "applying";
        await save(directory, receipt);
        await writeFileAtomic(
          file.path,
          operations[index]!.bytes,
          file.kind === "replace"
            ? { overwrite: true, expectedBytes: backups[index]!, durable: true }
            : { durable: true },
        );
        file.status = "applied";
        await save(directory, receipt);
      }
      receipt.status = "applied";
    } catch (error) {
      receipt.status = "partial";
      receipt.error = error instanceof Error ? error.message : String(error);
    }
    await save(directory, receipt);
    return receipt;
  });
}

/** Read-only: absence never creates state directories. Invalid receipts fail closed. */
export async function readHistory(options: OperationOptions): Promise<OperationReceipt[]> {
  const loc = await location(options);
  let entries: string[];
  try {
    entries = await readdir(loc.directory);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  const receipts: OperationReceipt[] = [];
  for (const id of entries.filter((entry) => z.string().uuid().safeParse(entry).success)) {
    const receipt = receiptSchema.parse(
      JSON.parse(await readFile(join(loc.directory, id, "receipt.json"), "utf8")),
    );
    if (
      receipt.id !== id ||
      receipt.project !== loc.project ||
      receipt.files.some((file) => !isAbsolute(file.path))
    )
      throw new Error(`Invalid receipt identity: ${id}`);
    receipts.push(receipt);
  }
  return receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}
export async function getReceipt(id: string, options: OperationOptions): Promise<OperationReceipt> {
  const receipts = await readHistory(options);
  const receipt =
    id === "last"
      ? receipts.find((item) => item.status !== "undone")
      : receipts.find((item) => item.id === id);
  if (!receipt) throw new Error(`No operation receipt: ${id}`);
  return receipt;
}
async function undoFiles(receipt: OperationReceipt, directory: string) {
  const changes: { file: ReceiptFile; current: Buffer; before?: Buffer }[] = [];
  for (const file of receipt.files) {
    if (file.status === "pending" || file.status === "undone") continue;
    if (file.status === "undoing") throw new Error(`Interrupted undo requires inspection: ${file.path}`);
    if (file.status === "applying" && file.kind === "create" && !(await info(file.path))) continue;
    const current = await regularBytes(file.path);
    if (file.status === "applying" && file.kind === "replace" && contentHash(current) === file.beforeHash)
      continue;
    if (contentHash(current) !== file.afterHash) throw new Error(`Output changed: ${file.path}`);
    await checkInputs(file.inputs.filter((input) => input.path !== file.path));
    if (file.kind === "replace") {
      if (!file.backup || file.mode === undefined || !file.beforeHash)
        throw new Error(`Missing backup metadata: ${file.path}`);
      const before = await regularBytes(join(directory, file.backup));
      if (contentHash(before) !== file.beforeHash) throw new Error(`Backup corrupt: ${file.path}`);
      changes.push({ file, current, before });
    } else changes.push({ file, current });
  }
  return changes;
}
export async function undoOperation(
  id: string,
  options: OperationOptions & { readonly dryRun?: boolean },
): Promise<OperationReceipt> {
  options.signal?.throwIfAborted();
  const loc = await location(options);
  const perform = async (apply: boolean) => {
    const receipt = await getReceipt(id, options);
    const directory = join(loc.directory, receipt.id);
    const changes = await undoFiles(receipt, directory);
    if (!apply || receipt.status === "undone") return receipt;
    receipt.status = "undoing";
    await save(directory, receipt);
    try {
      for (const { file, current, before } of changes) {
        options.signal?.throwIfAborted();
        // Recheck immediately before touching each output (still no multi-file transaction).
        if (!(await regularBytes(file.path)).equals(current)) throw new Error(`Output changed: ${file.path}`);
        await checkInputs(file.inputs.filter((input) => input.path !== file.path));
        file.status = "undoing";
        await save(directory, receipt);
        if (before)
          await writeFileAtomic(file.path, before, {
            overwrite: true,
            expectedBytes: current,
            mode: file.mode!,
            durable: true,
          });
        else {
          await unlink(file.path);
          const parent = await open(dirname(file.path), "r");
          try {
            await parent.sync();
          } finally {
            await parent.close();
          }
        }
        file.status = "undone";
        await save(directory, receipt);
      }
      receipt.status = "undone";
      delete receipt.error;
    } catch (error) {
      receipt.status = "partial";
      receipt.error = error instanceof Error ? error.message : String(error);
    }
    await save(directory, receipt);
    return receipt;
  };
  return options.dryRun ? perform(false) : locked(loc.directory, () => perform(true));
}
