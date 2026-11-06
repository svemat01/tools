/** NUL-delimited Git selection; argv only, no shell and no HEAD requirement. */
import { lstat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { checkCommand, type CommandOptions, requireBinary, runCommand } from "./process.ts";

export interface GitSelection {
  root: string;
  files: string[];
  deleted: string[];
}
export async function selectGitChanges(
  targets: readonly string[],
  options: CommandOptions & { cwd: string },
): Promise<GitSelection> {
  const git = requireBinary("git", options.env ?? {}, "Install Git to use --changed.");
  const run = (args: string[]) => runCommand(git, args, options);
  const top = await run(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error("--changed requires a Git working tree; run inside a repository.");
  // Git appends exactly one newline, which may itself be part of the root name.
  const root = top.stdout.replace(/\n$/, "");
  const scopes = targets.map((target) => resolve(options.cwd, target));
  for (const scope of scopes) {
    const rel = relative(root, scope);
    if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Target is outside Git: ${scope}`);
  }
  const paths = new Set<string>();
  for (const args of [
    ["diff", "--name-only", "--no-renames", "-z", "--"],
    ["diff", "--cached", "--name-only", "--no-renames", "-z", "--"],
    ["ls-files", "--others", "--exclude-standard", "-z", "--"],
  ]) {
    const result = checkCommand(await runCommand(git, args, { ...options, cwd: root }));
    for (const name of result.stdout.split("\0").filter(Boolean)) {
      const path = resolve(root, name);
      if (scopes.some((scope) => path === scope || path.startsWith(`${scope}${sep}`))) paths.add(path);
      if (paths.size > 1000)
        throw new Error("Changed selection exceeds 1000 files; select a smaller directory.");
    }
  }
  for (const scope of scopes) {
    try {
      await lstat(scope);
    } catch (error) {
      // A selected tracked deletion is a valid explicit target. Unknown paths are errors.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT" && paths.has(scope)))
        throw error;
    }
  }
  const files: string[] = [];
  const deleted: string[] = [];
  for (const path of [...paths].sort()) {
    try {
      await lstat(path);
      files.push(path);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") deleted.push(path);
      else throw error;
    }
  }
  return { root, files, deleted };
}
