/** Bounded, read-only static sharing. The manifest is the allowlist for a session. */
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isIP } from "node:net";
import { join, parse, resolve } from "node:path";

export const SHARE_LIMITS = { entries: 5000, files: 1000, bytes: 100 * 1024 * 1024, depth: 16 };
const excluded = new Set(["node_modules", "vendor", "dist", "build", "coverage", "target", "out"]);
const allowed = (part: string) => !part.startsWith(".") && !excluded.has(part);

type Identity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
export interface ShareManifest {
  readonly root: string;
  readonly files: ReadonlyMap<string, Identity>;
  readonly bytes: number;
}

/** Check every component, including the selected root's ancestors. */
async function noSymlinks(path: string): Promise<void> {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symbolic links are not shared");
  }
}
const same = (a: Identity, b: Identity) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

export async function inspectShareDirectory(
  path: string,
  signal?: AbortSignal,
  limits = SHARE_LIMITS,
): Promise<ShareManifest> {
  const root = resolve(path);
  const files = new Map<string, Identity>();
  let bytes = 0;
  let entries = 0;
  await noSymlinks(root);
  if (!(await lstat(root)).isDirectory()) throw new Error("Share target must be a directory");
  async function walk(relative: string, depth: number): Promise<void> {
    signal?.throwIfAborted();
    if (depth > limits.depth) throw new Error("Share manifest depth limit exceeded");
    const directory = join(root, relative);
    await noSymlinks(directory);
    const dir = await opendir(directory);
    for await (const entry of dir) {
      signal?.throwIfAborted();
      if (++entries > limits.entries) throw new Error("Share manifest traversal limit exceeded");
      if (!allowed(entry.name) || entry.isSymbolicLink()) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(root, name);
      await noSymlinks(path);
      const stat = await lstat(path);
      if (stat.isDirectory()) await walk(name, depth + 1);
      else if (stat.isFile()) {
        if (files.size >= limits.files) throw new Error("Share manifest file limit exceeded");
        bytes += stat.size;
        if (bytes > limits.bytes) throw new Error("Share manifest size limit exceeded");
        files.set(name, {
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
        });
      }
    }
  }
  try {
    await walk("", 0);
    return { root, files: new Map([...files].sort(([a], [b]) => a.localeCompare(b))), bytes };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Share manifest")) throw error;
    throw new Error("Could not safely inspect share directory", { cause: error });
  }
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export function shareHandler(manifest: ShareManifest): (request: Request) => Promise<Response> {
  const index = `<!doctype html><meta charset="utf-8"><title>Shared files</title><h1>Shared files</h1><ul>${[...manifest.files.keys()].map((name) => `<li><a href="/${escapeHtml(name.split("/").map(encodeURIComponent).join("/"))}">${escapeHtml(name)}</a></li>`).join("")}</ul>`;
  return async (request) => {
    const head = request.method === "HEAD";
    const reply = (
      body: string | Uint8Array,
      status: number,
      type = "text/plain; charset=utf-8",
      length = typeof body === "string" ? Buffer.byteLength(body) : body.byteLength,
    ) =>
      new Response(head ? null : body, {
        status,
        headers: {
          "Content-Type": type,
          "Content-Length": String(length),
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "no-store",
        },
      });
    if (request.method !== "GET" && !head) return reply("Method not allowed", 405);
    let name: string;
    try {
      name = decodeURIComponent(new URL(request.url).pathname).slice(1);
      if (
        name &&
        name
          .split("/")
          .some(
            (part) =>
              !part ||
              !allowed(part) ||
              part.includes("\\") ||
              [...part].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
          )
      )
        return reply("Not found", 404);
    } catch {
      return reply("Not found", 404);
    }
    if (!name) {
      if (!manifest.files.has("index.html")) return reply(index, 200, "text/html; charset=utf-8");
      name = "index.html";
    }
    const identity = manifest.files.get(name);
    if (!identity) return reply("Not found", 404);
    let file;
    try {
      const path = join(manifest.root, name);
      await noSymlinks(path);
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || !same(identity, stat)) return reply("File changed; restart sharing", 409);
      await noSymlinks(path);
      const type = Bun.file(path).type || "application/octet-stream";
      if (head) return reply("", 200, type, identity.size);
      // Read at most the inspected length, even if a file grows during this request.
      const data = Buffer.alloc(identity.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset !== data.length || !same(identity, await file.stat()))
        return reply("File changed; restart sharing", 409);
      return reply(data, 200, type);
    } catch {
      return reply("Not found", 404);
    } finally {
      await file?.close();
    }
  };
}

/** Parse without DNS, requests or coercing alternate IPv4 spellings. */
export function parseShareService(input: string): string | undefined {
  if (/^\d+$/.test(input)) {
    const port = Number(input);
    if (port < 1 || port > 65535) throw new Error("Port must be 1–65535");
    return `http://127.0.0.1:${port}/`;
  }
  if (!/^[a-z][a-z\d+.-]*:/i.test(input)) return undefined;
  const match = /^(https?):\/\/(\[[^\]]+\]|[^/:?#@]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?$/i.exec(input);
  if (!match) throw new Error("Use an HTTP(S) loopback URL without credentials or fragment");
  const host = match[2]!.toLowerCase();
  const ipv4 = isIP(host) === 4 && host.split(".")[0] === "127";
  if (!(ipv4 || host === "[::1]" || host === "localhost"))
    throw new Error("Share service must use localhost, 127.x.x.x or [::1]");
  const port = match[3] === undefined ? undefined : Number(match[3]);
  if (port !== undefined && (port < 1 || port > 65535)) throw new Error("Port must be 1–65535");
  return new URL(input).href;
}

export function shareDuration(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(input);
  if (!match) throw new Error("Timeout must be a duration such as 30s, 5m or 1h");
  const ms = Number(match[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[match[2]!]!;
  if (ms < 1 || ms > 2147483647) throw new Error("Timeout must be between 1ms and 24 days");
  return ms;
}
