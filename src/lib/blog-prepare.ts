/** Plan and apply coordinated blog edits without deleting referenced originals. */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import { artifactEdits, findNotionArtifacts } from "./blog-artifacts.ts";
import { decodeURIComponentSafe, localReferencePath } from "./blog-paths.ts";
import type { BlogConfig, BlogPost } from "./blog.ts";
import {
  discoverFiles,
  displayPath,
  encodeTextFile,
  fileSize,
  planOutputPath,
  readFileBytes,
  readTextFile,
  type TextFile,
  writeFileAtomic,
} from "./fs.ts";
import { extensionForFormat, type ImageFormat, normalizeFormat, transformImage } from "./image.ts";
import {
  applyEdits,
  isExternalUrl,
  type MarkdownReference,
  normalizeBlankLines,
  parseMarkdown,
  protectedMarkdownRanges,
  splitUrlSuffix,
  stripTrackingParameters,
  type TextEdit,
  toUrlPath,
  urlEdit,
} from "./markdown.ts";
import { fixText } from "./unicode.ts";

export interface PlannedImage {
  readonly input: string;
  readonly output: string;
  readonly action: "convert" | "optimize";
  readonly before: number;
  readonly after: number;
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
  readonly reference: string;
  readonly nextUrl: string;
  readonly data: Uint8Array;
  /** Fingerprint of the source used to encode these bytes. */
  readonly originalHash: string;
}

export interface PlannedEdit {
  readonly reason: string;
  readonly line?: number;
  readonly before?: string;
  readonly after?: string;
}

export interface PreparePlan {
  readonly post: BlogPost;
  readonly entry: string;
  readonly original: string;
  readonly originalHash: string;
  readonly prepared: string;
  readonly edits: readonly PlannedEdit[];
  readonly images: readonly PlannedImage[];
  readonly unicodeReplacements: number;
  readonly collapsedBlankLines: number;
  readonly changed: boolean;
}

export interface PrepareOptions {
  readonly cwd: string;
  readonly dryRun?: boolean;
  readonly noImages?: boolean;
  readonly noUnicode?: boolean;
  /** Share across posts to reserve destinations and encode each asset once. */
  readonly session?: PrepareSession;
  readonly signal?: AbortSignal;
}

export interface PrepareSession {
  readonly images: Map<string, PlannedImage | undefined>;
  readonly outputs: Set<string>;
}

export function createPrepareSession(): PrepareSession {
  return { images: new Map(), outputs: new Set() };
}

function fingerprint(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export async function planBlogPrepare(
  post: BlogPost,
  config: BlogConfig,
  options: PrepareOptions,
): Promise<PreparePlan> {
  options.signal?.throwIfAborted();
  const file = await readTextFile(post.entry);
  const edits: PlannedEdit[] = [];
  const textEdits: TextEdit[] = [];
  const artifactList = config.prepare.notion ? findNotionArtifacts(file.text, post.entry) : [];
  const artifacts = artifactEdits(artifactList);
  const source = artifacts.length > 0 ? applyEdits(file.text, artifacts) : file.text;

  for (const artifact of artifactList) {
    edits.push({
      reason: "remove Notion export artifact",
      line: artifact.line,
      before: artifact.text.slice(0, 120),
    });
  }

  const parsed = parseMarkdown(source, post.entry);
  if (parsed.parseError) throw new Error(`Cannot prepare ${post.entry}: ${parsed.parseError}`);

  const images: PlannedImage[] = [];
  const session = options.session ?? createPrepareSession();
  const imageForReference = new Map<MarkdownReference, PlannedImage>();
  const usedInputs = new Set<string>();

  if (config.prepare.optimizeImages && !options.noImages) {
    for (const reference of parsed.references) {
      if (isExternalUrl(reference.url)) continue;
      const { path: urlPath } = splitUrlSuffix(reference.url);
      if (!urlPath) continue;
      const absolute = localReferencePath(
        post,
        { kind: "post", projectRoot: post.projectRoot, posts: [post] },
        config,
        decodeURIComponentSafe(urlPath),
      );
      if (!absolute || !existsSync(absolute)) continue;
      const extension = absolute.split(".").pop()?.toLowerCase() ?? "";
      if (!["png", "jpg", "jpeg", "webp", "avif", "gif", "svg"].includes(extension)) continue;

      options.signal?.throwIfAborted();
      if (!session.images.has(absolute)) {
        session.images.set(absolute, await planImage(absolute, post, config, session.outputs));
      }
      const image = session.images.get(absolute);
      if (!image) continue;
      const { suffix } = splitUrlSuffix(reference.url);
      const rewritten = `${imageUrlForReference(reference.url, image, post, config)}${suffix}`;
      if (!urlEdit(source, reference, rewritten)) continue;
      if (!usedInputs.has(absolute)) {
        images.push({ ...image, nextUrl: toUrlPath(relative(post.root, image.output)) });
        usedInputs.add(absolute);
      }
      imageForReference.set(reference, image);
    }
  }

  // One edit per reference: image rewriting and tracking-parameter removal
  // must compose, not overlap.
  for (const reference of parsed.references) {
    let nextUrl = reference.url;
    const image = imageForReference.get(reference);
    if (image) {
      const { suffix } = splitUrlSuffix(reference.url);
      nextUrl = `${imageUrlForReference(reference.url, image, post, config)}${suffix}`;
    }
    let removed: readonly string[] = [];
    if (config.prepare.stripTracking) {
      const stripped = stripTrackingParameters(nextUrl);
      nextUrl = stripped.url;
      removed = stripped.removed;
    }
    if (nextUrl === reference.url) continue;
    const edit = urlEdit(source, reference, nextUrl);
    if (!edit) continue;
    textEdits.push(edit);
    const reasons: string[] = [];
    if (image) {
      reasons.push(
        `optimize image ${displayPath(options.cwd, image.input)} → ${displayPath(options.cwd, image.output)}`,
      );
    }
    if (removed.length > 0) reasons.push(`remove tracking parameters (${removed.join(", ")})`);
    edits.push({
      reason: reasons.join("; "),
      line: reference.line,
      before: reference.url,
      after: nextUrl,
    });
  }

  let text = textEdits.length > 0 ? applyEdits(source, textEdits) : source;
  let unicodeReplacements = 0;
  if (config.prepare.fixUnicode && !options.noUnicode) {
    const ranges = protectedMarkdownRanges(text, post.entry);
    let cursor = 0;
    const parts: string[] = [];
    for (const range of ranges) {
      if (range.end <= cursor) continue;
      const start = Math.max(cursor, range.start);
      const fixed = fixText(text.slice(cursor, start), { typography: config.prepare.typography });
      parts.push(fixed.text, text.slice(start, range.end));
      unicodeReplacements += fixed.replacements;
      cursor = range.end;
    }
    const tail = fixText(text.slice(cursor), { typography: config.prepare.typography });
    parts.push(tail.text);
    unicodeReplacements += tail.replacements;
    text = parts.join("");
    if (unicodeReplacements > 0) {
      edits.push({ reason: `replace ${unicodeReplacements} invisible or typographic character(s)` });
    }
  }

  let collapsedBlankLines = 0;
  if (config.prepare.normalizeMarkdown) {
    const normalized = normalizeBlankLines(text, post.entry);
    text = normalized.text;
    collapsedBlankLines = normalized.collapsedBlankLines;
    if (normalized.changed) {
      edits.push({ reason: "normalize blank lines and trailing newline" });
    }
  }

  return {
    post,
    entry: post.entry,
    original: file.text,
    originalHash: fingerprint(file.bytes),
    prepared: text,
    edits,
    images,
    unicodeReplacements,
    collapsedBlankLines,
    changed: text !== file.text || images.length > 0,
  };
}

function imageUrlForReference(
  referenceUrl: string,
  image: PlannedImage,
  post: BlogPost,
  config: BlogConfig,
): string {
  if (!referenceUrl.startsWith("/")) return toUrlPath(relative(post.root, image.output));
  const base = config.publicDir ? join(post.projectRoot, config.publicDir) : post.projectRoot;
  return `/${toUrlPath(relative(base, image.output))}`;
}

async function planImage(
  input: string,
  post: BlogPost,
  config: BlogConfig,
  usedOutputs: Set<string>,
): Promise<PlannedImage | undefined> {
  const inputExtension = input.split(".").pop()?.toLowerCase() ?? "";
  const requested = config.prepare.imageFormat === "webp" ? "webp" : normalizeFormat(inputExtension);
  if (!requested) return undefined;
  // Do not create a chain of `-optimized` copies on repeated prepares.
  const sameFormat =
    config.prepare.imageFormat === "webp" ? inputExtension === "webp" : requested === inputExtension;
  if (sameFormat && basename(input, extname(input)).endsWith("-optimized")) return undefined;

  const originalHash = fingerprint(await readFileBytes(input));
  const before = await fileSize(input);
  let output: string;
  if (config.prepare.imageFormat === "webp" && inputExtension !== "webp") {
    output = await planOutputPath({
      input,
      cwd: post.root,
      extension: "webp",
      overwrite: false,
    });
  } else if (config.prepare.imageFormat === "webp" && inputExtension === "webp") {
    // Already WebP: only re-encode when resizing would help.
    output = await planOutputPath({
      input,
      cwd: post.root,
      extension: "webp",
      suffix: "-optimized",
      overwrite: false,
    });
  } else {
    output = await planOutputPath({
      input,
      cwd: post.root,
      extension: extensionForFormat(requested),
      suffix: "-optimized",
      overwrite: false,
    });
  }
  output = reserve(output, usedOutputs);

  const result = await transformImage(input, {
    resize: { width: config.prepare.imageWidth, withoutEnlargement: true },
    encode: {
      format: requested,
      quality: config.prepare.imageQuality,
      ...(requested === "png" ? { palette: true } : {}),
    },
  });

  if (fingerprint(await readFileBytes(input)) !== originalHash) {
    throw new Error(`${input} changed while planning; re-run blog prepare`);
  }

  // A same-format optimization that makes the file larger is not useful.
  if (config.prepare.imageFormat === "keep" && result.bytes >= before) return undefined;
  if (config.prepare.imageFormat === "webp" && inputExtension === "webp" && result.bytes >= before) {
    return undefined;
  }

  const relativeUrl = toUrlPath(relative(post.root, output));
  return {
    input,
    output,
    action: config.prepare.imageFormat === "webp" && inputExtension !== "webp" ? "convert" : "optimize",
    before,
    after: result.bytes,
    width: result.width,
    height: result.height,
    format: result.format,
    reference: input,
    nextUrl: relativeUrl,
    data: result.data,
    originalHash,
  };
}

function reserve(desired: string, used: Set<string>): string {
  if (!used.has(desired) && !existsSync(desired)) {
    used.add(desired);
    return desired;
  }
  const directory = dirname(desired);
  const extension = extname(desired);
  const stem = basename(desired, extension);
  for (let counter = 1; counter < 10_000; counter++) {
    const candidate = join(directory, `${stem}-${counter}${extension}`);
    if (!used.has(candidate) && !existsSync(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error(`Could not reserve an output name for ${desired}`);
}

export interface PrepareResult {
  readonly plan: PreparePlan;
  readonly writtenImages: readonly string[];
  readonly deletedOriginals: readonly string[];
  readonly retainedOriginals: readonly { readonly path: string; readonly reason: string }[];
}

/** Includes completed mutations when an I/O failure prevents the remaining writes. */
export class PrepareApplyError extends Error {
  constructor(
    message: string,
    readonly completedEntries: readonly string[],
    readonly writtenImages: readonly string[],
    options: ErrorOptions,
    readonly deletedOriginals: readonly string[] = [],
  ) {
    super(message, options);
    this.name = "PrepareApplyError";
  }
}

/**
 * Preflight the whole batch, publish assets, update entries, then consider
 * deletions. An error never starts deletions before every entry is updated.
 * Individual writes are atomic; a multi-file filesystem transaction is not
 * promised, so failures expose the completed operations for recovery.
 */
export async function applyBlogPreparePlans(
  plans: readonly PreparePlan[],
  config: BlogConfig,
  options: { readonly signal?: AbortSignal } = {},
): Promise<PrepareResult[]> {
  const files = new Map<string, TextFile>();
  const images = new Map<string, PlannedImage>();
  const entries = new Set<string>();
  for (const plan of plans) {
    options.signal?.throwIfAborted();
    if (entries.has(plan.entry)) throw new Error(`Duplicate prepare plan for ${plan.entry}`);
    entries.add(plan.entry);
    const file = await readTextFile(plan.entry);
    if (fingerprint(file.bytes) !== plan.originalHash) {
      throw new Error(`${plan.entry} changed after planning; re-run blog prepare`);
    }
    files.set(plan.entry, file);
    for (const image of plan.images) {
      const previous = images.get(image.output);
      if (previous && (previous.input !== image.input || !Buffer.from(previous.data).equals(image.data))) {
        throw new Error(`Conflicting plans for ${image.output}`);
      }
      images.set(image.output, image);
    }
  }
  for (const image of images.values()) {
    if (fingerprint(await readFileBytes(image.input)) !== image.originalHash) {
      throw new Error(`${image.input} changed after planning; re-run blog prepare`);
    }
    if (existsSync(image.output) && !(await readFileBytes(image.output)).equals(image.data)) {
      throw new Error(`${image.output} appeared after planning; re-run blog prepare`);
    }
  }

  const writtenImages: string[] = [];
  const completedEntries: string[] = [];
  try {
    for (const image of images.values()) {
      options.signal?.throwIfAborted();
      if (!existsSync(image.output)) await writeFileAtomic(image.output, image.data);
      else if (!(await readFileBytes(image.output)).equals(image.data)) {
        throw new Error(`${image.output} changed after preflight; re-run blog prepare`);
      }
      writtenImages.push(image.output);
    }
    for (const plan of plans) {
      options.signal?.throwIfAborted();
      const file = files.get(plan.entry)!;
      if (plan.prepared !== file.text) {
        await writeFileAtomic(plan.entry, encodeTextFile(file, plan.prepared), {
          overwrite: true,
          expectedBytes: file.bytes,
        });
      }
      completedEntries.push(plan.entry);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PrepareApplyError(
      `Prepare stopped after updating ${completedEntries.length} entries and publishing ${writtenImages.length} images: ${detail}. Originals were preserved.`,
      completedEntries,
      writtenImages,
      { cause: error },
    );
  }

  const deletedOriginals = new Set<string>();
  const retainedOriginals: { path: string; reason: string }[] = [];
  try {
    if (config.prepare.deleteOriginals) {
      for (const image of images.values()) {
        options.signal?.throwIfAborted();
        const owner = plans.find((plan) => plan.images.some((candidate) => candidate.input === image.input));
        const local = owner ? relative(owner.post.root, image.input) : "..";
        let reason: string | undefined;
        if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
          reason = "shared or public asset; only unreferenced post-local originals can be deleted";
        } else if (fingerprint(await readFileBytes(image.input)) !== image.originalHash) {
          reason = "source changed after planning";
        } else if (!(await readFileBytes(image.output)).equals(image.data)) {
          reason = "prepared image changed after publication";
        } else {
          reason = await remainingReferenceReason(image, owner!.post.projectRoot);
        }
        if (reason) retainedOriginals.push({ path: image.input, reason });
        else {
          await rm(image.input);
          deletedOriginals.add(image.input);
        }
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PrepareApplyError(
      `Prepare updated ${completedEntries.length} entries, but original cleanup stopped after deleting ${deletedOriginals.size} originals: ${detail}`,
      completedEntries,
      writtenImages,
      { cause: error },
      [...deletedOriginals],
    );
  }

  return plans.map((plan) => ({
    plan,
    writtenImages: plan.images.map((image) => image.output),
    deletedOriginals: plan.images
      .filter((image) => deletedOriginals.has(image.input))
      .map((image) => image.input),
    retainedOriginals: retainedOriginals.filter((entry) =>
      plan.images.some((image) => image.input === entry.path),
    ),
  }));
}

/**
 * Conservatively retain an original if its filename remains anywhere in the
 * project's readable source files (including metadata and unselected posts).
 * This intentionally accepts false positives rather than breaking a link.
 */
async function remainingReferenceReason(
  image: PlannedImage,
  projectRoot: string,
): Promise<string | undefined> {
  const found = await discoverFiles([projectRoot], { cwd: projectRoot, includeHidden: true });
  if (found.errors.length > 0 || found.missing.length > 0 || found.unsupported.length > 0) {
    return "project reference scan was incomplete";
  }
  const binaryExtensions = new Set([
    "png",
    "jpg",
    "jpeg",
    "webp",
    "avif",
    "gif",
    "tif",
    "tiff",
    "heic",
    "heif",
    "mp4",
    "webm",
    "mov",
    "mp3",
    "wav",
    "woff",
    "woff2",
    "ttf",
    "pdf",
    "zip",
    "gz",
  ]);
  const name = basename(image.input);
  for (const path of found.files) {
    if (
      path === image.input ||
      path === image.output ||
      binaryExtensions.has(extname(path).slice(1).toLowerCase())
    )
      continue;
    try {
      const file = await readTextFile(path);
      const decoded = file.text.replace(/(?:%[a-f0-9]{2})+/gi, (value) => decodeURIComponentSafe(value));
      if (decoded.includes(name)) return `possible remaining reference in ${path}`;
    } catch {
      return `cannot inspect ${path} for remaining references`;
    }
  }
  return undefined;
}

export async function applyBlogPrepare(plan: PreparePlan, config: BlogConfig): Promise<PrepareResult> {
  return (await applyBlogPreparePlans([plan], config))[0]!;
}
