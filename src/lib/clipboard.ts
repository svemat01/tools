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

export type ClipboardErrorCode =
  "unavailable" | "access" | "cancelled" | "timeout" | "too-large" | "unsupported" | "invalid";

export class ClipboardError extends Error {
  constructor(
    readonly code: ClipboardErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClipboardError";
  }
}

export type ClipboardPayload =
  | { kind: "text"; mime: "text/plain"; bytes: Uint8Array; text: string; backend: string }
  | {
      kind: "image";
      mime: "image/png";
      bytes: Uint8Array;
      width: number;
      height: number;
      backend: string;
    };

export interface ClipboardReadOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
  /** Total deadline, including format negotiation. Defaults to 3 seconds. */
  readonly timeoutMs?: number;
  /** Maximum payload size (default 16 MiB); format listings are capped at 64 KiB. */
  readonly maxBytes?: number;
  readonly find?: (name: string) => string | undefined;
  /** Injectable byte runner; must honor the supplied signal and byte limit. */
  readonly run?: ClipboardRunner;
}

export type ClipboardRunner = (
  command: string,
  args: readonly string[],
  options: {
    env: Readonly<Record<string, string | undefined>>;
    signal: AbortSignal;
    maxBytes: number;
  },
) => Promise<Uint8Array>;

/** Never include child diagnostics: a backend may echo clipboard secrets on failure. */
const readProcess: ClipboardRunner = async (command, args, options) => {
  const child = Bun.spawn([command, ...args], {
    env: { ...process.env, ...options.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const abort = () => child.kill("SIGKILL");
  options.signal.addEventListener("abort", abort, { once: true });
  try {
    options.signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of child.stdout) {
      options.signal.throwIfAborted();
      size += chunk.length;
      if (size > options.maxBytes) {
        throw new ClipboardError("too-large", "Clipboard exceeds the byte limit; select less content.");
      }
      chunks.push(chunk);
    }
    if ((await child.exited) !== 0) {
      throw new ClipboardError(
        "access",
        "Clipboard access failed; check your desktop session and permissions.",
      );
    }
    return Buffer.concat(chunks);
  } finally {
    options.signal.removeEventListener("abort", abort);
    child.kill("SIGKILL");
    await child.exited;
  }
};

/** Explicit, bounded clipboard input. Reading never clears or modifies the selection. */
export async function readClipboard(options: ClipboardReadOptions = {}): Promise<ClipboardPayload> {
  if (options.signal?.aborted) throw new ClipboardError("cancelled", "Clipboard read cancelled.");
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 3000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("Clipboard limits must be positive safe integers");
  }
  const env = options.env ?? process.env;
  const find = options.find ?? ((name: string) => findBinary(name, env));
  const platform = options.platform ?? process.platform;
  const names =
    platform === "darwin"
      ? ["pbpaste"]
      : platform === "win32"
        ? ["powershell.exe"]
        : env.WAYLAND_DISPLAY
          ? ["wl-paste", "xclip", "xsel", "powershell.exe"]
          : ["xclip", "xsel", "wl-paste", "powershell.exe"];
  const backend = names.find((name) => find(name) !== undefined);
  if (!backend) {
    throw new ClipboardError(
      "unavailable",
      "No clipboard reader found. Use pbpaste (macOS), wl-paste (Wayland), xclip/xsel (X11), or PowerShell (Windows/WSL) in a desktop session.",
    );
  }
  const executable = find(backend)!;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const run = options.run ?? readProcess;
  async function read(args: readonly string[], limit = maxBytes) {
    signal.throwIfAborted();
    const bytes = await run(executable, args, { env, signal, maxBytes: limit });
    signal.throwIfAborted();
    if (bytes.length > limit)
      throw new ClipboardError("too-large", "Clipboard exceeds the byte limit; select less content.");
    return bytes;
  }
  try {
    let mime = "text/plain";
    let args: readonly string[] = [];
    if (backend === "wl-paste" || backend === "xclip") {
      const listing = await read(
        backend === "wl-paste" ? ["--list-types"] : ["-selection", "clipboard", "-o", "-t", "TARGETS"],
        Math.min(maxBytes, 65536),
      );
      const types = new TextDecoder()
        .decode(listing)
        .split(/\r?\n/)
        .map((s) => s.trim());
      if (types.includes("image/png")) mime = "image/png";
      else if (types.some((type) => type.startsWith("image/"))) {
        throw new ClipboardError(
          "unsupported",
          "Clipboard image format is unsupported; copy a PNG image instead.",
        );
      } else if (
        !types.some((type) => /^(text\/plain(?:;.*)?|UTF8_STRING|STRING|text\/uri-list)$/.test(type))
      ) {
        throw new ClipboardError("unsupported", "Clipboard has no supported text or PNG representation.");
      } else {
        mime =
          types.find((type) => type.startsWith("text/plain")) ??
          (types.includes("UTF8_STRING")
            ? "UTF8_STRING"
            : types.includes("text/uri-list")
              ? "text/uri-list"
              : "STRING");
      }
      args =
        backend === "wl-paste"
          ? ["--no-newline", "--type", mime]
          : ["-selection", "clipboard", "-o", "-t", mime];
    } else if (backend === "xsel") args = ["--clipboard", "--output"];
    else if (backend === "powershell.exe")
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $v = Get-Clipboard -Raw -Format Text; if ($null -eq $v) { exit 2 }; [Console]::Write($v)",
      ];
    const bytes = await read(args);
    if (mime === "image/png") {
      if (!Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new ClipboardError("invalid", "Clipboard advertised PNG but returned different bytes.");
      }
      const { default: sharp } = await import("sharp");
      try {
        const image = sharp(bytes, { limitInputPixels: 16_000_000 });
        const meta = await image.metadata();
        // Decode too: metadata alone accepts truncated PNG data.
        await image.stats();
        signal.throwIfAborted();
        if (!meta.width || !meta.height) throw new Error("dimensions");
        return { kind: "image", mime: "image/png", bytes, width: meta.width, height: meta.height, backend };
      } catch {
        throw new ClipboardError(
          "invalid",
          "Clipboard PNG is invalid or exceeds the 16 million pixel limit.",
        );
      }
    }
    if (bytes.length === 0) {
      throw new ClipboardError(
        "unsupported",
        "Clipboard is empty or has no supported text representation. pbpaste, xsel and PowerShell read text only; use wl-paste or xclip for PNG input.",
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ClipboardError(
        "unsupported",
        "Clipboard is not supported UTF-8 text; use a PNG-capable backend for images.",
      );
    }
    if (text.includes("\0"))
      throw new ClipboardError(
        "unsupported",
        "Clipboard contains binary data; this backend supports text only.",
      );
    return { kind: "text", mime: "text/plain", bytes, text, backend };
  } catch (error) {
    if (options.signal?.aborted) throw new ClipboardError("cancelled", "Clipboard read cancelled.");
    if (deadline.aborted)
      throw new ClipboardError("timeout", "Clipboard read timed out; check your desktop session.");
    if (error instanceof ClipboardError) throw error;
    throw new ClipboardError(
      "access",
      "Clipboard access failed; check your desktop session and permissions.",
    );
  }
}
