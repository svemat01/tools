/** Explicit local-file opening only. No shell, remote URL, or automatic browser launch. */
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { findBinary } from "./process.ts";

export async function openLocalFile(
  path: string,
  options: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly platform?: NodeJS.Platform;
  },
): Promise<boolean> {
  if (options.signal?.aborted) return false;
  const timeout = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(timeout) || timeout < 1)
    throw new RangeError("Open timeout must be a positive integer");
  const absolute = resolve(path);
  try {
    if (!(await lstat(absolute)).isFile()) return false;
  } catch {
    return false;
  }
  const platform = options.platform ?? process.platform;
  const binary = findBinary(
    platform === "darwin" ? "open" : platform === "win32" ? "explorer.exe" : "xdg-open",
    options.env,
  );
  if (!binary) return false;
  const deadline = AbortSignal.timeout(timeout);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const abort = () => {
    try {
      child?.kill("SIGKILL");
    } catch {
      /* Already exited. */
    }
  };
  try {
    child = Bun.spawn([binary, pathToFileURL(absolute).href], {
      env: { ...process.env, ...options.env },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return (await child.exited) === 0 && !signal.aborted;
  } catch {
    return false;
  } finally {
    signal.removeEventListener("abort", abort);
    abort();
    await child?.exited;
  }
}
