/**
 * Application context: runtime facilities handed to every handler.
 *
 * This is deliberately separate from Router models. Models are validated
 * command-line configuration; context is everything else a handler needs
 * (output streams, environment, cancellation, application services).
 */

export interface Output {
  write(text: string): unknown;
  readonly isTTY?: boolean;
}

export interface BaseContext {
  /** The executable name (the root route's `name()`). */
  readonly program: string;
  readonly stdout: Output;
  readonly stderr: Output;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Aborted when the process is interrupted (SIGINT/SIGTERM). */
  readonly signal: AbortSignal;
}

/** Per-invocation overrides; anything omitted comes from the real process. */
export interface RunOptions {
  readonly stdout?: Output;
  readonly stderr?: Output;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export function baseContext(program: string, options: RunOptions = {}): BaseContext {
  return {
    program,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    signal: options.signal ?? new AbortController().signal,
  };
}
