/** Bounded, offline image review. No source metadata or source bytes enter the report. */
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { renderImageReview } from "./image-review.ts";
import { inspectImage, transformImage } from "./image.ts";

export const TUNE_LIMITS = {
  inputBytes: 12 * 1024 * 1024,
  pixels: 24_000_000,
  width: 2560,
  variants: 5,
  embeddedBytes: 20 * 1024 * 1024,
} as const;
export interface TuneOptions {
  readonly width?: number;
  readonly qualities?: readonly number[];
  readonly format?: "webp" | "avif";
  readonly signal?: AbortSignal;
}
export interface ReviewImage {
  readonly url: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
}
export interface ReviewVariant extends ReviewImage {
  readonly quality: number;
  readonly format: "webp" | "avif";
  readonly filename: string;
  readonly savings: number;
}
export interface ImageReview {
  readonly filename: string;
  readonly source: {
    readonly bytes: number;
    readonly width: number;
    readonly height: number;
    readonly format: string;
  };
  readonly reference: ReviewImage;
  readonly variants: readonly ReviewVariant[];
}

export function validateTuneOptions(options: TuneOptions): {
  width: number;
  qualities: number[];
  format: "webp" | "avif";
} {
  const width = options.width ?? 1600;
  const qualities = [...(options.qualities ?? [60, 75, 85])];
  const format = options.format ?? "webp";
  if (!Number.isInteger(width) || width < 1 || width > TUNE_LIMITS.width)
    throw new Error(`Width must be 1-${TUNE_LIMITS.width}`);
  if (
    qualities.length < 1 ||
    qualities.length > TUNE_LIMITS.variants ||
    new Set(qualities).size !== qualities.length ||
    qualities.some((q) => !Number.isInteger(q) || q < 1 || q > 100)
  )
    throw new Error("Provide 1-5 unique integer qualities from 1 to 100");
  if (format !== "webp" && format !== "avif") throw new Error("Format must be webp or avif");
  return { width, qualities, format };
}

/** Snapshot a bounded regular file so inspection and every encode see identical bytes. */
export async function createImageReview(input: string, options: TuneOptions = {}): Promise<ImageReview> {
  const { width, qualities, format } = validateTuneOptions(options);
  options.signal?.throwIfAborted();
  const handle = await open(input, "r");
  let source: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Tune input must be a regular image file");
    if (stat.size > TUNE_LIMITS.inputBytes) throw new Error("Tune input exceeds 12 MiB limit");
    const buffer = Buffer.alloc(TUNE_LIMITS.inputBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > TUNE_LIMITS.inputBytes) throw new Error("Tune input exceeds 12 MiB limit");
    source = buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
  const directory = await mkdtemp(join(tmpdir(), "sv-tune-"));
  try {
    const snapshot = join(directory, "input");
    await writeFile(snapshot, source, { mode: 0o600 });
    const info = await inspectImage(snapshot);
    if (!["jpeg", "png", "webp", "avif", "heif", "gif", "tiff"].includes(info.format))
      throw new Error(`Unsupported tune input format: ${info.format}`);
    if (info.animated) throw new Error("Animated or multi-page images are unsupported by img tune v1");
    if (info.width * info.height > TUNE_LIMITS.pixels)
      throw new Error("Tune input exceeds 24 megapixel limit");
    options.signal?.throwIfAborted();
    const resize = { width, withoutEnlargement: true };
    const reference = await transformImage(snapshot, { resize, encode: { format: "png" } });
    let embeddedBytes = reference.bytes;
    const checkBudget = () => {
      if (embeddedBytes > TUNE_LIMITS.embeddedBytes)
        throw new Error("Tune report exceeds 20 MiB embedded image limit; reduce --width or variant count");
    };
    checkBudget();
    const filename = basename(input);
    const stem =
      filename.slice(0, filename.length - extname(filename).length).replace(/[^\p{L}\p{N}._-]/gu, "_") ||
      "image";
    const variants: ReviewVariant[] = [];
    for (const quality of qualities) {
      options.signal?.throwIfAborted();
      const result = await transformImage(snapshot, { resize, encode: { format, quality } });
      embeddedBytes += result.bytes;
      checkBudget();
      variants.push({
        url: `data:image/${format};base64,${result.data.toString("base64")}`,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        quality,
        format,
        filename: `${stem}-q${quality}.${format}`,
        savings: 100 * (1 - result.bytes / source.length),
      });
    }
    const rotated = (info.orientation ?? 1) >= 5;
    return {
      filename,
      source: {
        bytes: source.length,
        width: rotated ? info.height : info.width,
        height: rotated ? info.width : info.height,
        format: info.format,
      },
      reference: {
        url: `data:image/png;base64,${reference.data.toString("base64")}`,
        bytes: reference.bytes,
        width: reference.width,
        height: reference.height,
      },
      variants,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function buildImageTuneReport(
  input: string,
  options: TuneOptions = {},
): Promise<{ html: string; review: ImageReview }> {
  const review = await createImageReview(input, options);
  return { html: renderImageReview(review), review };
}
