/** Read-only ready previews, coalesced by bounded filesystem metadata signatures. */
import { createHash } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { IGNORE_DIRECTORIES } from "./fs.ts";
import { selectGitChanges } from "./git-selection.ts";
import { PROJECT_MARKERS } from "./project.ts";
import { inspectReady, planReady, type ReadyOptions } from "./ready.ts";

export interface WatchOptions extends ReadyOptions {
  readonly intervalMs?: number;
  readonly once?: boolean;
}
export interface WatchEvent {
  readonly command: "watch";
  readonly schemaVersion: 1;
  readonly event: "check" | "error";
  readonly reason: "initial" | "change";
  readonly sequence: number;
  readonly status: "planned" | "reused" | "noop" | "blocked";
  readonly checks: { files: number; errors: number; warnings: number; infos: number; ok: boolean };
  readonly summary: {
    files: number;
    outputs: number;
    reusedOutputs: number;
    unsupported: number;
    skipped: number;
  };
  readonly failures: readonly string[];
  readonly issues: readonly {
    file: string;
    severity: string;
    code: string;
    message: string;
    line?: number;
  }[];
}
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error));
const zeroChecks = () => ({ files: 0, errors: 0, warnings: 0, infos: 0, ok: false });
const zeroSummary = () => ({ files: 0, outputs: 0, reusedOutputs: 0, unsupported: 0, skipped: 0 });

/** Include hidden project configs and Git selection without reading file contents or encoding images. */
async function signature(targets: readonly string[], options: WatchOptions): Promise<string> {
  const scopes = (targets.length ? targets : ["."]).map((path) => resolve(options.cwd, path));
  const out = resolve(options.cwd, options.outDir ?? ".sv-ready");
  const state =
    options.stateRoot ??
    resolve(options.env.XDG_STATE_HOME ?? join(options.env.HOME ?? homedir(), ".local/state"), "sv");
  const rows: string[] = [];
  const seen = new Set<string>();
  const configDirectories = new Set<string>();
  let entries = 0;
  let files = 0;
  async function probe(path: string) {
    options.signal?.throwIfAborted();
    try {
      const info = await lstat(path);
      rows.push(
        JSON.stringify([
          path,
          info.mode,
          info.dev,
          info.ino,
          info.isDirectory() ? 0 : info.size,
          info.isDirectory() ? 0 : info.mtimeMs,
          info.isDirectory() ? 0 : info.ctimeMs,
        ]),
      );
      return info;
    } catch (error) {
      rows.push(JSON.stringify([path, detail(error)]));
      return undefined;
    }
  }
  async function walk(path: string): Promise<void> {
    options.signal?.throwIfAborted();
    if (seen.has(path)) return;
    seen.add(path);
    if (
      inside(path, out) ||
      inside(path, state) ||
      path.split(sep).some((part) => IGNORE_DIRECTORIES.has(part))
    )
      return;
    if (++entries > 1000) throw new Error("Watch discovery exceeds 1000 entries; select a smaller directory");
    const info = await probe(path);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) {
      if (++files > 200) throw new Error("Watch selection exceeds 200 files; select a smaller directory");
    } else if (info.isDirectory()) {
      configDirectories.add(path);
      const children: string[] = [];
      for await (const child of await opendir(path)) {
        options.signal?.throwIfAborted();
        if (children.length + entries >= 1000)
          throw new Error("Watch discovery exceeds 1000 entries; select a smaller directory");
        if (!child.name.startsWith(".")) children.push(join(path, child.name));
      }
      for (const child of children.sort()) await walk(child);
    }
  }
  let selected = scopes;
  if (options.changed) {
    const changes = await selectGitChanges(targets.length ? targets : ["."], options);
    selected = changes.files;
    rows.push(JSON.stringify(["git-selection", changes.files, changes.deleted]));
  }
  for (const path of selected.sort()) await walk(path);
  for (const scope of [resolve(options.cwd), ...scopes]) {
    let current = (await lstat(scope).catch(() => undefined))?.isDirectory() ? scope : dirname(scope);
    for (let depth = 0; depth < 64; depth++) {
      configDirectories.add(current);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  // Explicitly fingerprint configs even though normal discovery skips hidden entries.
  for (const directory of [...configDirectories].sort()) {
    for (const marker of PROJECT_MARKERS) await probe(join(directory, marker));
  }
  return createHash("sha256").update(rows.sort().join("\n")).digest("hex");
}

function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((done) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      done();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) finish();
  });
}

/** Never calls applyReady or executeFilePlan; every event is safe to serialize. */
export async function* watchReady(
  targets: readonly string[],
  options: WatchOptions,
): AsyncGenerator<WatchEvent> {
  const interval = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60000)
    throw new Error("Watch interval must be an integer from 100 to 60000 milliseconds");
  let previous: string | undefined;
  let sequence = 0;
  while (!options.signal?.aborted) {
    let current: string;
    try {
      current = await signature(targets, options);
    } catch (error) {
      if (options.signal?.aborted) return;
      current = `signature-error:${detail(error)}`;
    }
    if (current !== previous) {
      const reason = previous === undefined ? "initial" : "change";
      previous = current;
      sequence++;
      try {
        if (current.startsWith("signature-error:")) throw new Error(current.slice("signature-error:".length));
        const plan = await planReady(await inspectReady(targets, options));
        const status = plan.failures.length
          ? "blocked"
          : plan.actions.length
            ? "planned"
            : plan.reused.length
              ? "reused"
              : "noop";
        yield {
          command: "watch",
          schemaVersion: 1,
          event: "check",
          reason,
          sequence,
          status,
          checks: plan.checks,
          summary: {
            files: plan.entries.filter(
              (entry) => !["directory", "project", "blog", "generated", "deleted"].includes(entry.kind),
            ).length,
            outputs: plan.actions.length,
            reusedOutputs: plan.reused.length,
            unsupported: plan.entries.filter((entry) => entry.status === "unsupported").length,
            skipped: plan.entries.filter((entry) => entry.status === "skipped").length,
          },
          failures: plan.failures,
          issues: plan.entries.flatMap((entry) => entry.issues ?? []),
        };
      } catch (error) {
        if (options.signal?.aborted) return;
        yield {
          command: "watch",
          schemaVersion: 1,
          event: "error",
          reason,
          sequence,
          status: "blocked",
          checks: zeroChecks(),
          summary: zeroSummary(),
          failures: [detail(error)],
          issues: [],
        };
      }
    }
    if (options.once || options.signal?.aborted) return;
    await waitForPoll(interval, options.signal);
  }
}
