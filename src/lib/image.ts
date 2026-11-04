/**
 * Shared Sharp-based image processing.
 *
 * Commands translate their CLI options into a `TransformSpec`; they do not
 * chain Sharp directly. This keeps `img web`, `img og`, `img resize` and
 * `blog prepare` on one implementation (and one set of safety defaults).
 */

import sharp, { type Metadata, type ResizeOptions, type Sharp } from "sharp";

import { fileSize } from "./fs.ts";

export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "gif" | "tiff";
export type Fit = "inside" | "cover" | "contain" | "fill" | "outside";

export const IMAGE_EXTENSIONS = [
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
  "svg",
] as const;

export function normalizeFormat(format: string | undefined): ImageFormat | undefined {
  switch (format?.toLowerCase()) {
    case "jpg":
    case "jpeg":
      return "jpeg";
    case "png":
      return "png";
    case "webp":
      return "webp";
    case "avif":
      return "avif";
    case "gif":
      return "gif";
    case "tif":
    case "tiff":
      return "tiff";
    default:
      return undefined;
  }
}

export function extensionForFormat(format: ImageFormat): string {
  return format === "jpeg" ? "jpg" : format;
}

export function isAnimated(metadata: Metadata): boolean {
  return (metadata.pages ?? 1) > 1;
}

export interface ImageInfo {
  readonly path: string;
  readonly bytes: number;
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly space?: string;
  readonly channels?: number;
  readonly hasAlpha: boolean;
  readonly density?: number;
  readonly orientation?: number;
  readonly pages: number;
  readonly pageHeight?: number;
  readonly animated: boolean;
  readonly loop?: number;
  readonly delay?: readonly number[];
  readonly hasProfile: boolean;
  readonly hasExif: boolean;
}

export async function inspectImage(path: string): Promise<ImageInfo> {
  const metadata = await sharp(path).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (width === undefined || height === undefined) {
    throw new Error(`Unable to determine image dimensions for ${path}`);
  }
  return {
    path,
    bytes: await fileSize(path),
    format: metadata.format ?? "unknown",
    width,
    height,
    ...(metadata.space === undefined ? {} : { space: metadata.space }),
    ...(metadata.channels === undefined ? {} : { channels: metadata.channels }),
    hasAlpha: metadata.hasAlpha ?? false,
    ...(metadata.density === undefined ? {} : { density: metadata.density }),
    ...(metadata.orientation === undefined ? {} : { orientation: metadata.orientation }),
    pages: metadata.pages ?? 1,
    ...(metadata.pageHeight === undefined ? {} : { pageHeight: metadata.pageHeight }),
    animated: isAnimated(metadata),
    ...(metadata.loop === undefined ? {} : { loop: metadata.loop }),
    ...(metadata.delay === undefined ? {} : { delay: metadata.delay }),
    hasProfile: metadata.hasProfile ?? false,
    hasExif: metadata.exif !== undefined,
  };
}

export interface ResizeSpec {
  readonly width?: number;
  readonly height?: number;
  readonly fit?: Fit;
  /** Defaults to true: a resize never enlarges an image unless asked. */
  readonly withoutEnlargement?: boolean;
  readonly background?: string;
  readonly position?: string;
}

export interface EncodeSpec {
  readonly format: ImageFormat;
  readonly quality?: number;
  readonly lossless?: boolean;
  /** PNG palette mode. Off by default for general resizing. */
  readonly palette?: boolean;
  readonly colors?: number;
  readonly effort?: number;
  readonly compressionLevel?: number;
}

export interface TransformSpec {
  readonly resize?: ResizeSpec;
  readonly encode: EncodeSpec;
  /** Apply EXIF orientation before resizing. Defaults to true. */
  readonly autoOrient?: boolean;
}

export interface TransformResult {
  readonly data: Buffer;
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

function applyResize(pipeline: Sharp, resize: ResizeSpec): Sharp {
  if (resize.width === undefined && resize.height === undefined) return pipeline;
  const options: ResizeOptions = {
    fit: resize.fit ?? "inside",
    withoutEnlargement: resize.withoutEnlargement ?? true,
    ...(resize.width === undefined ? {} : { width: resize.width }),
    ...(resize.height === undefined ? {} : { height: resize.height }),
    ...(resize.background === undefined ? {} : { background: resize.background }),
    ...(resize.position === undefined ? {} : { position: resize.position }),
  };
  return pipeline.resize(options);
}

function applyEncode(pipeline: Sharp, encode: EncodeSpec): Sharp {
  switch (encode.format) {
    case "webp":
      return pipeline.webp({
        quality: encode.quality ?? 82,
        effort: encode.effort ?? 4,
        lossless: encode.lossless ?? false,
        smartSubsample: true,
      });
    case "avif":
      return pipeline.avif({
        quality: encode.quality ?? 55,
        effort: encode.effort ?? 4,
        lossless: encode.lossless ?? false,
      });
    case "png":
      return pipeline.png({
        compressionLevel: encode.compressionLevel ?? 9,
        palette: encode.palette ?? false,
        effort: encode.effort ?? 7,
        ...(encode.quality === undefined ? {} : { quality: encode.quality }),
        ...(encode.colors === undefined ? {} : { colors: encode.colors }),
      });
    case "jpeg":
      return pipeline.jpeg({
        quality: encode.quality ?? 82,
        mozjpeg: true,
      });
    case "gif":
      return pipeline.gif();
    case "tiff":
      return pipeline.tiff({ compression: "lzw" });
  }
}

/**
 * Decode once, optionally resize, then encode. The caller receives bytes and
 * writes them atomically; this function never touches the output path.
 */
export async function transformImage(input: string, spec: TransformSpec): Promise<TransformResult> {
  const metadata = await sharp(input).metadata();
  const animated = isAnimated(metadata) && spec.encode.format !== "jpeg" && spec.encode.format !== "png";
  const source = sharp(input, animated ? { animated: true } : {});
  let pipeline = spec.autoOrient === false ? source : source.rotate();
  if (spec.resize) pipeline = applyResize(pipeline, spec.resize);
  pipeline = applyEncode(pipeline, spec.encode);

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    data,
    format: spec.encode.format,
    width: info.width,
    height: info.height,
    bytes: data.length,
  };
}

/** Parse `1920x1080`, `1920X1080` or `1920×1080`. */
export function parseDimensions(value: string): { readonly width: number; readonly height: number } {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(value);
  if (!match)
    throw new Error(`Invalid dimensions ${JSON.stringify(value)}; expected WIDTHxHEIGHT, e.g. 1920x1080`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(
      `Invalid dimensions ${JSON.stringify(value)}; width and height must be positive integers`,
    );
  }
  return { width, height };
}

/** Format dimensions for humans: `1920×1080`. */
export function formatDimensions(width: number, height: number): string {
  return `${width}×${height}`;
}
