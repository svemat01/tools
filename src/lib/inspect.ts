import { lstat, open, opendir } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { IMAGE_EXTENSIONS, type ImageInfo, inspectImage } from "./image.ts";
import { findBinary } from "./process.ts";
import { assertNoSymlinks, type DiscoveredProject, discoverProject, loadProjectConfig } from "./project.ts";
import { probeVideo, VIDEO_EXTENSIONS, type VideoInfo } from "./video.ts";

export interface InspectOptions {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}
export type FileKind = "image" | "video" | "markdown" | "other";
export interface Suggestion {
  argv: string[];
  command: string;
}
interface BaseResult {
  path: string;
  suggestions: Suggestion[];
}
export type Metadata<T> =
  { status: "available"; value: T } | { status: "unavailable"; reason: string; action: string };
export type InspectResult = BaseResult &
  (
    | { kind: "image"; bytes: number; metadata: Metadata<ImageInfo> }
    | { kind: "video"; bytes: number; metadata: Metadata<VideoInfo> }
    | {
        kind: "markdown";
        bytes: number;
        metadata: { title: string | null; sampledBytes: number; truncated: boolean };
      }
    | { kind: "other"; bytes: number }
    | { kind: "directory" | "project" | "blog"; project: DiscoveredProject | null; summary: DirectorySummary }
    | { kind: "error"; message: string }
  );
export interface DirectorySummary {
  limit: number;
  truncated: boolean;
  entries: { name: string; kind: FileKind | "directory" }[];
  skipped: number;
}
export const INSPECT_ENTRY_LIMIT = 200;
const SKIP = new Set(["node_modules", "vendor", "dist", "build", "coverage", "target", "out", "sv-ready"]);

export function classifyFile(path: string): FileKind {
  const extension = extname(path).slice(1).toLowerCase();
  if ((IMAGE_EXTENSIONS as readonly string[]).includes(extension)) return "image";
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return "video";
  return ["md", "mdx", "markdown"].includes(extension) ? "markdown" : "other";
}
function suggest(...argv: string[]): Suggestion {
  return { argv, command: ["sv", ...argv].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ") };
}
async function summarize(path: string, signal?: AbortSignal): Promise<DirectorySummary> {
  const entries: DirectorySummary["entries"] = [];
  let skipped = 0;
  let scanned = 0;
  let truncated = false;
  const directory = await opendir(path);
  for await (const entry of directory) {
    signal?.throwIfAborted();
    if (scanned++ >= INSPECT_ENTRY_LIMIT) {
      truncated = true;
      break;
    }
    if (entry.isSymbolicLink() || entry.name.startsWith(".") || SKIP.has(entry.name)) {
      skipped++;
      continue;
    }
    if (entry.isDirectory()) entries.push({ name: entry.name, kind: "directory" });
    else if (entry.isFile()) entries.push({ name: entry.name, kind: classifyFile(entry.name) });
    else skipped++;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { limit: INSPECT_ENTRY_LIMIT, truncated, entries, skipped };
}

/** Read-only, local inspection. Directory samples never recursively probe assets. */
export async function inspectPath(input: string, options: InspectOptions): Promise<InspectResult> {
  const path = resolve(options.cwd, input);
  try {
    options.signal?.throwIfAborted();
    await assertNoSymlinks(path);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      const project = await discoverProject(path);
      const loaded = project ? await loadProjectConfig(project.root) : null;
      const kind = project?.root === path ? (loaded?.blog ? "blog" : "project") : "directory";
      return {
        path,
        kind,
        project: project ?? null,
        summary: await summarize(path, options.signal),
        suggestions:
          kind === "blog"
            ? [suggest("blog", "check", path)]
            : [suggest("--cwd", project?.root ?? path, "doctor"), suggest("gremlins", path)],
      };
    }
    if (!stat.isFile()) throw new Error("Only regular files and directories can be inspected");
    const base = { path, bytes: stat.size };
    const kind = classifyFile(path);
    if (kind === "image") {
      let metadata: Metadata<ImageInfo>;
      try {
        metadata = { status: "available", value: await inspectImage(path) };
      } catch {
        metadata = {
          status: "unavailable",
          reason: "Image metadata could not be decoded",
          action: "Check that the file is a supported, valid image.",
        };
      }
      return {
        ...base,
        kind,
        metadata,
        suggestions: [suggest("img", "info", path), suggest("img", "web", path, "--dry-run")],
      };
    }
    if (kind === "video") {
      const ffprobe = findBinary("ffprobe", options.env);
      let metadata: Metadata<VideoInfo> = {
        status: "unavailable",
        reason: "ffprobe was not found on PATH",
        action: "Install FFmpeg (includes ffprobe) and add it to PATH.",
      };
      if (ffprobe) {
        try {
          metadata = {
            status: "available",
            value: await probeVideo(path, ffprobe, { ...options, localOnly: true }),
          };
        } catch {
          options.signal?.throwIfAborted();
          metadata = {
            status: "unavailable",
            reason: "ffprobe could not read video metadata",
            action: "Check the video file and run ffprobe directly for diagnostics.",
          };
        }
      }
      return { ...base, kind, metadata, suggestions: [suggest("video", "webm", path, "--dry-run")] };
    }
    if (kind === "markdown") {
      const handle = await open(path, "r");
      let text: string;
      let sampledBytes: number;
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, 65536));
        sampledBytes = (await handle.read(buffer, 0, buffer.length, 0)).bytesRead;
        text = buffer.subarray(0, sampledBytes).toString("utf8");
      } finally {
        await handle.close();
      }
      return {
        ...base,
        kind,
        metadata: {
          title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? null,
          sampledBytes,
          truncated: stat.size > sampledBytes,
        },
        suggestions: [suggest("blog", "check", path), suggest("gremlins", path)],
      };
    }
    return { ...base, kind, suggestions: [suggest("gremlins", path)] };
  } catch (error) {
    return {
      path,
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
      suggestions: [],
    };
  }
}
