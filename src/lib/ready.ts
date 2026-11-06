/** Preview-only inspection and planning. Buffers are bounded and never written until applyReady. */
import { lstat, open, opendir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import sharp from "sharp";

import { type BlogIssue, checkBlog, loadBlogConfig, resolveBlogProject } from "./blog.ts";
import { IGNORE_DIRECTORIES, planOutputPath } from "./fs.ts";
import { selectGitChanges } from "./git-selection.ts";
import { renderImageReview } from "./image-review.ts";
import { transformImage } from "./image.ts";
import { classifyFile, inspectPath, type InspectResult } from "./inspect.ts";
import { contentHash, executeFilePlan, type FileOperation, type OperationOptions } from "./operations.ts";
import { assertNoSymlinks, discoverProject, loadProjectConfig } from "./project.ts";

export const READY_LIMITS = {
  files: 200,
  entries: 1000,
  inputBytes: 12 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  pixels: 24_000_000,
  width: 2560,
} as const;
export interface ReadyOptions extends OperationOptions {
  changed?: boolean;
  outDir?: string;
  width?: number;
  quality?: number;
  format?: "webp" | "avif";
  review?: boolean;
}
export interface ReadyEntry {
  path: string;
  kind: string;
  status: "inspected" | "unsupported" | "skipped" | "error";
  reason?: string;
  inspection?: InspectResult;
  issues?: readonly BlogIssue[];
  image?: { width: number; height: number; format: string };
  suggestions: string[][];
  hash?: string;
}
export interface ReadyInspection {
  entries: ReadyEntry[];
  /** Image snapshots used by planReady, never include these in CLI output. */
  sources: Map<string, Buffer>;
  options: ReadyOptions;
}
export interface ReadyAction {
  source: string;
  destination: string;
  kind: "image" | "review";
  bytes: number;
  hash: string;
}
export interface ReadyPlan {
  entries: ReadyEntry[];
  actions: ReadyAction[];
  failures: string[];
  checks: { files: number; errors: number; warnings: number; infos: number; ok: boolean };
  /** Encoded bytes held until application; never include these in CLI output. */
  operations: FileOperation[];
  options: ReadyOptions;
}
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const inside = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);
function settings(options: ReadyOptions) {
  const width = options.width ?? 1600;
  const quality = options.quality ?? 82;
  const format = options.format ?? "webp";
  if (!Number.isInteger(width) || width < 1 || width > READY_LIMITS.width)
    throw new Error("Width must be 1-2560");
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("Quality must be 1-100");
  if (format !== "webp" && format !== "avif") throw new Error("Format must be webp or avif");
  return { width, quality, format };
}
async function snapshot(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > READY_LIMITS.inputBytes)
      throw new Error("Input must be a regular file of at most 12 MiB");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, READY_LIMITS.inputBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size) throw new Error("Input grew during inspection; retry");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export async function inspectReady(
  targets: readonly string[],
  options: ReadyOptions,
): Promise<ReadyInspection> {
  settings(options);
  const entries: ReadyEntry[] = [];
  const sources = new Map<string, Buffer>();
  const out = resolve(options.cwd, options.outDir ?? ".sv-ready");
  const state =
    options.stateRoot ??
    resolve(options.env.XDG_STATE_HOME ?? join(options.env.HOME ?? homedir(), ".local/state"), "sv");
  const visited = new Set<string>();
  const files: string[] = [];
  let count = 0;
  let bytes = 0;
  const fail = (path: string, error: unknown) =>
    entries.push({ path, kind: "error", status: "error", reason: message(error), suggestions: [] });
  async function walk(path: string) {
    options.signal?.throwIfAborted();
    if (visited.has(path)) return;
    visited.add(path);
    if (++count > READY_LIMITS.entries)
      throw new Error("Discovery exceeds 1000 entries; select a smaller directory");
    if (
      inside(path, out) ||
      inside(path, state) ||
      path
        .split(sep)
        .some((part) => IGNORE_DIRECTORIES.has(part) || part === ".sv-ready" || part === "sv-ready")
    ) {
      entries.push({
        path,
        kind: "generated",
        status: "skipped",
        reason: "Generated, vendor or history output excluded",
        suggestions: [],
      });
      return;
    }
    try {
      await assertNoSymlinks(path);
      const stat = await lstat(path);
      if (stat.isDirectory()) {
        const inspection = await inspectPath(path, options);
        if (inspection.kind === "error") throw new Error(inspection.message);
        entries.push({
          path,
          kind: inspection.kind,
          status: "inspected",
          inspection,
          suggestions: inspection.suggestions.map((s) => s.argv),
        });
        const children: string[] = [];
        for await (const child of await opendir(path)) {
          if (children.length + count >= READY_LIMITS.entries)
            throw new Error("Discovery exceeds 1000 entries; select a smaller directory");
          if (!child.name.startsWith(".")) children.push(join(path, child.name));
        }
        for (const child of children.sort()) await walk(child);
      } else if (stat.isFile()) {
        if (files.length >= READY_LIMITS.files)
          throw new Error("Selection exceeds 200 files; select a smaller directory");
        files.push(path);
      } else throw new Error("Only regular files and directories are supported");
    } catch (error) {
      fail(path, error);
    }
  }
  const scopes = targets.length ? targets : ["."];
  let selected = scopes.map((p) => resolve(options.cwd, p));
  if (options.changed) {
    const changes = await selectGitChanges(scopes, options);
    selected = changes.files;
    entries.push(
      ...changes.deleted.map((path): ReadyEntry => ({
        path,
        kind: "deleted",
        status: "skipped",
        reason: "Deleted in working tree; no content to prepare",
        suggestions: [],
      })),
    );
    // Validate project config even for a clean selection.
    const project = await discoverProject(options.cwd);
    if (project) await loadProjectConfig(project.root);
  }
  for (const path of selected.sort()) await walk(path);
  for (const path of files.sort()) {
    options.signal?.throwIfAborted();
    try {
      const project = await discoverProject(path);
      const loaded = project ? await loadProjectConfig(project.root) : null;
      const kind = classifyFile(path);
      if (kind === "image") {
        const source = await snapshot(path);
        bytes += source.length;
        if (bytes > READY_LIMITS.totalBytes)
          throw new Error("Input snapshot budget exceeds 64 MiB; select fewer files");
        sources.set(path, source);
        entries.push({ path, kind, status: "inspected", hash: contentHash(source), suggestions: [] });
      } else {
        const inspection = await inspectPath(path, options);
        if (inspection.kind === "error") throw new Error(inspection.message);
        if (kind === "markdown") {
          if ((await lstat(path)).size > READY_LIMITS.inputBytes)
            throw new Error("Markdown exceeds 12 MiB; inspect separately");
          const loadedConfig = loaded?.blog ?? (await loadBlogConfig(dirname(path)));
          // Ordinary READMEs and notes are not blog posts. Validate their content
          // without inventing mandatory frontmatter or slug conventions.
          const config = loadedConfig.source
            ? loadedConfig.config
            : {
                ...loadedConfig.config,
                metadataFiles: [],
                checks: { ...loadedConfig.config.checks, metadata: false, slugs: false },
              };
          const blog = await resolveBlogProject(path, options.cwd, config);
          const checked = await checkBlog(blog, config, { cwd: options.cwd });
          if (checked.issues.some((issue) => issue.code === "unreadable-entry"))
            throw new Error("Blog entry could not be read; run sv blog check for diagnostics");
          entries.push({
            path,
            kind,
            status: "inspected",
            inspection,
            issues: checked.issues,
            reason: loadedConfig.source
              ? "Checks only; use sv blog prepare separately for rewrites"
              : "Markdown content checks only; no blog metadata conventions are required",
            suggestions: loadedConfig.source
              ? [
                  ["blog", "check", path],
                  ["blog", "prepare", path, "--dry-run"],
                ]
              : [],
          });
        } else {
          if (
            "metadata" in inspection &&
            "status" in inspection.metadata &&
            inspection.metadata.status === "unavailable"
          )
            throw new Error(`${inspection.metadata.reason}. ${inspection.metadata.action}`);
          entries.push({
            path,
            kind,
            status: "unsupported",
            inspection,
            reason:
              kind === "video"
                ? "Video application is not supported; run the suggested conversion separately"
                : "No ready action for this file type",
            suggestions: kind === "video" ? [["video", "webm", path, "--dry-run"]] : [],
          });
        }
      }
    } catch (error) {
      fail(path, error);
    }
  }
  options.signal?.throwIfAborted();
  return {
    entries: entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    sources,
    options: { ...options },
  };
}
export async function planReady(inspection: ReadyInspection): Promise<ReadyPlan> {
  const { options } = inspection;
  const { width, quality, format } = settings(options);
  const entries = inspection.entries.map((entry) => ({ ...entry }));
  const actions: ReadyAction[] = [];
  const operations: FileOperation[] = [];
  const reserved = new Set<string>();
  let outputBytes = 0;
  for (const entry of entries) {
    if (entry.kind !== "image" || entry.status !== "inspected") continue;
    try {
      options.signal?.throwIfAborted();
      const source = inspection.sources.get(entry.path)!;
      if (contentHash(source) !== entry.hash) throw new Error("Snapshot changed; inspect again");
      const info = await sharp(source, { limitInputPixels: READY_LIMITS.pixels }).metadata();
      if (!info.width || !info.height || info.width * info.height > READY_LIMITS.pixels)
        throw new Error("Image exceeds 24 megapixels or has unknown dimensions");
      if (
        (info.pages ?? 1) > 1 ||
        !["jpeg", "png", "webp", "avif", "heif", "gif", "tiff"].includes(info.format ?? "")
      ) {
        entry.status = "unsupported";
        entry.reason =
          "Only static raster images are supported; animation, multiple pages and SVG require a separate workflow";
        continue;
      }
      entry.image = { width: info.width, height: info.height, format: info.format ?? "unknown" };
      const orientedWidth = (info.orientation ?? 1) >= 5 ? info.height : info.width;
      const sourceFormat = info.format === "heif" && info.compression === "av1" ? "avif" : info.format;
      if (
        sourceFormat === format &&
        orientedWidth <= width &&
        options.quality === undefined &&
        !options.review
      ) {
        entry.status = "skipped";
        entry.reason = "Already target format within width; pass --quality to reencode";
        continue;
      }
      const encoded = await transformImage(source, { resize: { width }, encode: { format, quality } });
      const destination = await planOutputPath({
        input: entry.path,
        cwd: options.cwd,
        outDir: options.outDir ?? ".sv-ready",
        extension: format,
        reserved,
      });
      const inputs = [{ path: entry.path, hash: entry.hash! }];
      const pending: FileOperation[] = [{ kind: "create", path: destination, bytes: encoded.data, inputs }];
      const planned: ReadyAction[] = [
        { source: entry.path, destination, kind: "image", bytes: encoded.bytes, hash: entry.hash! },
      ];
      if (options.review) {
        const reference = await transformImage(source, { resize: { width }, encode: { format: "png" } });
        if (reference.bytes + encoded.bytes > 20 * 1024 * 1024)
          throw new Error("Review exceeds 20 MiB embedded image budget; reduce width");
        const html = renderImageReview({
          filename: basename(entry.path),
          source: {
            bytes: source.length,
            width: orientedWidth,
            height: (info.orientation ?? 1) >= 5 ? info.width : info.height,
            format: info.format ?? "unknown",
          },
          reference: {
            url: `data:image/png;base64,${reference.data.toString("base64")}`,
            bytes: reference.bytes,
            width: reference.width,
            height: reference.height,
          },
          variants: [
            {
              url: `data:image/${format};base64,${encoded.data.toString("base64")}`,
              bytes: encoded.bytes,
              width: encoded.width,
              height: encoded.height,
              quality,
              format,
              filename: basename(destination),
              savings: 100 * (1 - encoded.bytes / source.length),
            },
          ],
        });
        const report = await planOutputPath({
          input: entry.path,
          cwd: options.cwd,
          outDir: options.outDir ?? ".sv-ready",
          extension: "html",
          suffix: "-review",
          reserved,
        });
        pending.push({ kind: "create", path: report, bytes: Buffer.from(html), inputs });
        planned.push({
          source: entry.path,
          destination: report,
          kind: "review",
          bytes: Buffer.byteLength(html),
          hash: entry.hash!,
        });
      }
      outputBytes += pending.reduce((sum, op) => sum + op.bytes.length, 0);
      if (outputBytes > READY_LIMITS.totalBytes)
        throw new Error("Output budget exceeds 64 MiB; select fewer files or reduce width");
      operations.push(...pending);
      actions.push(...planned);
    } catch (error) {
      entry.status = "error";
      entry.reason = message(error);
    }
  }
  options.signal?.throwIfAborted();
  const issues = entries.flatMap((entry) => entry.issues ?? []);
  const errors = issues.filter((issue) => issue.severity === "error");
  return {
    entries,
    actions,
    operations,
    options,
    checks: {
      files: entries.filter((entry) => entry.issues !== undefined).length,
      errors: errors.length,
      warnings: issues.filter((issue) => issue.severity === "warn").length,
      infos: issues.filter((issue) => issue.severity === "info").length,
      ok: errors.length === 0,
    },
    failures: [
      ...entries.filter((entry) => entry.status === "error").map((entry) => `${entry.path}: ${entry.reason}`),
      ...errors.map((issue) => `${issue.file}:${issue.line ?? 1}: ${issue.code}: ${issue.message}`),
    ],
  };
}
export async function applyReady(plan: ReadyPlan) {
  if (plan.failures.length)
    throw new Error(`Ready planning failed; no files written:\n${plan.failures.join("\n")}`);
  if (!plan.operations.length) return null;
  return executeFilePlan(plan.operations, plan.options);
}
