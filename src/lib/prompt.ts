/** Minimal interactive confirmation for destructive or bulk changes. */

import { createInterface } from "node:readline/promises";

/**
 * Ask a yes/no question. A non-interactive terminal is always "no": commands
 * that need consent must require an explicit `--yes` there instead.
 */
export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(`${message} [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
