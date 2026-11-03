import type { AnyRoute } from "@bomb.sh/router";

import type { App, Output, RunOptions } from "../../src/kit/index.ts";

export interface Captured extends Output {
  readonly text: string;
}

export function capture(): Captured {
  let text = "";
  return {
    write(chunk: string) {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run an app in-process with captured output and an empty environment. */
export async function runApp<R extends AnyRoute, C>(
  app: App<R, C>,
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const stdout = capture();
  const stderr = capture();
  const code = await app.run(argv, { env: {}, cwd: "/", stdout, stderr, ...options });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Candidate values only, as Tab prints them. */
export function values<R extends AnyRoute, C>(app: App<R, C>, words: readonly string[]): string[] {
  return app.complete(words).candidates.map((candidate) => candidate.value);
}
