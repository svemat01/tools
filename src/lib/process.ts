/**
 * External process helpers.
 *
 * A missing optional binary is a normal, explainable state: `requireBinary()`
 * turns it into an actionable error instead of a spawn stack trace.
 */

export interface CommandOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly stdin?: "ignore" | "inherit" | "pipe";
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly command: string;
  readonly args: readonly string[];
}

export function findBinary(name: string, env: Readonly<Record<string, string | undefined>> = {}): string | undefined {
  const path = env.PATH ?? process.env.PATH;
  const found = Bun.which(name, path === undefined ? {} : { PATH: path });
  return found ?? undefined;
}

export function requireBinary(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
  hint: string,
): string {
  const found = findBinary(name, env);
  if (!found) {
    throw new Error(`${name} is required but was not found on PATH. ${hint}`);
  }
  return found;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const env = { ...process.env, ...options.env };
  try {
    const child = Bun.spawn([command, ...args], {
      env,
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { code, stdout, stderr, command, args };
  } catch (error) {
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      command,
      args,
    };
  }
}

/** A short, useful message from a failed process without dumping megabytes. */
export function commandError(result: CommandResult): string {
  const detail = (result.stderr || result.stdout).trim();
  const lines = detail.split(/\r?\n/).filter(Boolean);
  const tail = lines.slice(-8).join("\n");
  return `${result.command} exited with code ${result.code}${tail ? `:\n${tail}` : ""}`;
}

/** Assert a command succeeded, throwing its stderr when it did not. */
export function checkCommand(result: CommandResult): CommandResult {
  if (result.code !== 0) throw new Error(commandError(result));
  return result;
}
