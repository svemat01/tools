import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AppContext } from "../../context.ts";
import type { SecretSource } from "../../lib/jwt.ts";

export interface TokenInput {
  readonly token?: string;
  readonly file?: string;
  readonly stdin?: boolean;
}

export interface SecretInput {
  readonly secretEnv?: string;
  readonly secretFile?: string;
  readonly secretStdin?: boolean;
}

export interface PayloadInput {
  readonly payload?: string;
  readonly payloadFile?: string;
  readonly payloadStdin?: boolean;
}

function chosen(sources: readonly (string | undefined)[]): string[] {
  return sources.filter((source): source is string => source !== undefined);
}

/** Resolve exactly one token source. Tokens are trimmed; JWT whitespace is never meaningful. */
export async function readToken(input: TokenInput, context: AppContext): Promise<string> {
  const sources = chosen([
    input.token === undefined ? undefined : "an argument",
    input.file === undefined ? undefined : "--file",
    input.stdin === true ? "--stdin" : undefined,
  ]);
  if (sources.length === 0) throw new Error("Provide a token argument, --file, or --stdin");
  if (sources.length > 1) throw new Error("Provide only one token source: argument, --file, or --stdin");

  if (input.token !== undefined) {
    const token = input.token.trim();
    if (!token) throw new Error("The token argument is empty");
    return token;
  }
  if (input.file !== undefined) {
    const path = resolve(context.cwd, input.file);
    try {
      const token = (await readFile(path, "utf8")).trim();
      if (!token) throw new Error("the file is empty");
      return token;
    } catch (error) {
      throw new Error(`Cannot read token file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const token = (await Bun.stdin.text()).trim();
  if (!token) throw new Error("No token was provided on stdin");
  return token;
}

/** Describe the secret source without reading it; `readSecret()` does the I/O. */
export function secretSource(input: SecretInput): SecretSource {
  const sources = chosen([
    input.secretEnv === undefined ? undefined : "--secret-env",
    input.secretFile === undefined ? undefined : "--secret-file",
    input.secretStdin === true ? "--secret-stdin" : undefined,
  ]);
  if (sources.length === 0) {
    throw new Error("Provide a secret with --secret-env NAME, --secret-file PATH, or --secret-stdin");
  }
  if (sources.length > 1) {
    throw new Error("Provide only one secret source: --secret-env, --secret-file, or --secret-stdin");
  }
  if (input.secretEnv !== undefined) return { kind: "env", name: input.secretEnv };
  if (input.secretFile !== undefined) return { kind: "file", path: input.secretFile };
  return { kind: "stdin" };
}

/** Read a JSON object used as the JWT payload. No source means an empty object. */
export async function readPayload(
  input: PayloadInput,
  context: AppContext,
): Promise<Record<string, unknown>> {
  const sources = chosen([
    input.payload === undefined ? undefined : "--payload",
    input.payloadFile === undefined ? undefined : "--payload-file",
    input.payloadStdin === true ? "--payload-stdin" : undefined,
  ]);
  if (sources.length > 1) {
    throw new Error("Provide only one payload source: --payload, --payload-file, or --payload-stdin");
  }
  if (sources.length === 0) return {};

  let text: string;
  if (input.payload !== undefined) {
    text = input.payload;
  } else if (input.payloadFile !== undefined) {
    const path = resolve(context.cwd, input.payloadFile);
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      throw new Error(`Cannot read payload file ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    text = await Bun.stdin.text();
  }

  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Payload must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Reject configurations that would need to read stdin twice. */
export function checkStdin(input: {
  readonly tokenStdin?: boolean;
  readonly secretStdin?: boolean;
  readonly payloadStdin?: boolean;
}): void {
  const uses = [input.tokenStdin, input.secretStdin, input.payloadStdin].filter(Boolean).length;
  if (uses > 1) {
    throw new Error("Only one value can be read from stdin; use a file or environment variable for the others");
  }
}
