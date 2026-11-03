/** Best-effort clipboard support for local tools such as `sv tunnel`. */

import { findBinary } from "./process.ts";

interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

const CANDIDATES: readonly ClipboardCommand[] = [
  { command: "pbcopy", args: [] },
  { command: "wl-copy", args: [] },
  { command: "xclip", args: ["-selection", "clipboard"] },
  { command: "xsel", args: ["--clipboard", "--input"] },
  { command: "clip.exe", args: [] },
];

export function clipboardCommand(
  env: Readonly<Record<string, string | undefined>>,
): ClipboardCommand | undefined {
  return CANDIDATES.find((candidate) => findBinary(candidate.command, env) !== undefined);
}

export async function copyToClipboard(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const candidate = clipboardCommand(env);
  if (!candidate) return false;
  try {
    const child = Bun.spawn([candidate.command, ...candidate.args], {
      env: { ...process.env, ...env },
      stdin: new Blob([text]),
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await child.exited) === 0;
  } catch {
    return false;
  }
}
