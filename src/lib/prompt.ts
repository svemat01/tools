/** Minimal interactive confirmation for destructive or bulk changes. */

import { createInterface } from "node:readline/promises";

import type { Output } from "../kit/context.ts";

/**
 * Ask a yes/no question. A non-interactive terminal is always "no": commands
 * that need consent must require an explicit `--yes` there instead.
 */
export async function confirm(
  message: string,
  options: { readonly output?: Output; readonly signal?: AbortSignal } = {},
): Promise<boolean> {
  if (!process.stdin.isTTY || options.signal?.aborted) return false;
  const readline = createInterface({ input: process.stdin });
  try {
    (options.output ?? process.stderr).write(`${message} [y/N] `);
    const answer = await readline.question("", options.signal ? { signal: options.signal } : {});
    return /^(y|yes)$/i.test(answer.trim());
  } catch (error) {
    if (options.signal?.aborted) return false;
    throw error;
  } finally {
    readline.close();
  }
}
