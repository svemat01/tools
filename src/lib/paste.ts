import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ClipboardPayload } from "./clipboard.ts";

/** Metadata only: callers can serialize this without retaining clipboard secrets. */
export async function summarizeClipboard(payload: ClipboardPayload, cwd: string) {
  const base = { bytes: payload.bytes.length, backend: payload.backend };
  if (payload.kind === "image") {
    return {
      ...base,
      kind: "image" as const,
      mime: payload.mime,
      width: payload.width,
      height: payload.height,
    };
  }
  const text = payload.text.trim();
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(text)) {
    return { ...base, kind: "jwt" as const, tokenType: "JWT-shaped", verified: false };
  }
  const lines = text.split(/\r?\n/).filter((line) => line && !line.startsWith("#"));
  // Limit filesystem probing as well as input bytes. Never open FIFOs/devices.
  if (lines.length > 0 && lines.length <= 256) {
    let readable = 0;
    for (const line of lines) {
      try {
        const path = line.startsWith("file:") ? fileURLToPath(line) : resolve(cwd, line);
        const info = await stat(path);
        if (!info.isFile() && !info.isDirectory()) continue;
        await access(path, constants.R_OK);
        readable++;
      } catch {
        /* Unknown text is not a path. Never echo failed candidates. */
      }
    }
    if (readable === lines.length) return { ...base, kind: "paths" as const, count: readable };
  }
  try {
    const url = new URL(text);
    if (["http:", "https:"].includes(url.protocol)) return { ...base, kind: "url" as const };
  } catch {
    /* Generic text. */
  }
  return { ...base, kind: "text" as const, lines: payload.text.split(/\r?\n/).length };
}
