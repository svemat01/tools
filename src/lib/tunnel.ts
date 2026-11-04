/**
 * Cloudflare Quick Tunnel wrapper.
 *
 * One backend, no provider abstraction: `cloudflared tunnel --url ...` is the
 * shortest useful way to share a local port. The process is owned by this
 * module so Ctrl+C and errors always clean it up.
 */

import type { Output } from "../kit/index.ts";
import { findBinary } from "./process.ts";

export const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function findTunnelUrl(text: string): string | undefined {
  return TUNNEL_URL_PATTERN.exec(text)?.[0];
}

export function cloudflaredArgs(port: number, host = "localhost"): string[] {
  return ["tunnel", "--no-autoupdate", "--url", `http://${host}:${port}`];
}

export interface TunnelOptions {
  readonly port: number;
  readonly name?: string;
  readonly copy?: boolean;
  readonly json?: boolean;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly stdout: Output;
  readonly stderr: Output;
  readonly copyUrl?: (url: string) => Promise<boolean>;
}

export interface TunnelResult {
  readonly url: string;
  readonly code: number;
  readonly copied: boolean;
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

export async function startTunnel(options: TunnelOptions): Promise<TunnelResult> {
  const binary = findBinary("cloudflared", options.env);
  if (!binary) {
    throw new Error(
      "cloudflared is required but was not found on PATH. Install it with `brew install cloudflared` " +
        "or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.",
    );
  }

  const label = options.name ? ` "${options.name}"` : "";
  options.stderr.write(
    `warning: a public tunnel${label} will expose http://localhost:${options.port} to anyone with the URL.\n` +
      "         Stop it with Ctrl+C when you are done.\n",
  );

  const child = Bun.spawn([binary, ...cloudflaredArgs(options.port)], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  let url: string | undefined;
  let copied = false;
  const abort = () => {
    try {
      child.kill();
    } catch {
      // The process may already have exited.
    }
  };
  options.signal.addEventListener("abort", abort, { once: true });

  const handleLine = async (line: string): Promise<void> => {
    if (!line) return;
    if (!url) {
      const found = findTunnelUrl(line);
      if (found) {
        url = found;
        if (!options.json) options.stdout.write(`\n  ${found}\n\n`);
        if (options.copy && options.copyUrl) {
          copied = await options.copyUrl(found);
          options.stderr.write(
            copied ? "Copied the public URL to the clipboard.\n" : "Could not copy to the clipboard.\n",
          );
        }
        return;
      }
    }
    if (!options.json) options.stderr.write(`${line}\n`);
  };

  try {
    await Promise.all([
      (async () => {
        for await (const line of readLines(child.stdout)) await handleLine(line);
      })(),
      (async () => {
        for await (const line of readLines(child.stderr)) await handleLine(line);
      })(),
    ]);
    const code = await child.exited;
    if (!url) {
      throw new Error(`cloudflared exited (code ${code}) before publishing a public URL`);
    }
    if (options.json) options.stdout.write(`${JSON.stringify({ url })}\n`);
    return { url, code: options.signal.aborted ? 0 : code === 0 ? 0 : 1, copied };
  } finally {
    options.signal.removeEventListener("abort", abort);
    abort();
  }
}
