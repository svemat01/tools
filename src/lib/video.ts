/**
 * Initial video conversion support: efficient WebM/VP9 output via FFmpeg.
 *
 * This is intentionally a single conversion pipeline, not a video editor.
 * Dimensions are computed from ffprobe output in TypeScript so the scale
 * filter is explicit and testable, and no-upscale is the default.
 */

import { rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { ensureDirectory, fileSize, planOutputPath } from "./fs.ts";
import { checkCommand, commandError, requireBinary, runCommand } from "./process.ts";

export const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "mkv", "webm", "avi", "gif", "ogv"] as const;

export interface VideoInfo {
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly codec?: string;
  readonly format?: string;
  readonly bitRate?: number;
  readonly frameRate?: number;
  readonly hasAudio: boolean;
}

interface ProbeStream {
  readonly codec_type?: string;
  readonly codec_name?: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: string;
  readonly bit_rate?: string;
  readonly avg_frame_rate?: string;
}

interface ProbeFormat {
  readonly duration?: string;
  readonly bit_rate?: string;
  readonly format_name?: string;
}

interface ProbeOutput {
  readonly streams?: readonly ProbeStream[];
  readonly format?: ProbeFormat;
}

export function parseProbeOutput(text: string): VideoInfo {
  let parsed: ProbeOutput;
  try {
    parsed = JSON.parse(text) as ProbeOutput;
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const duration = parseNumber(video?.duration) ?? parseNumber(parsed.format?.duration);
  const bitRate = parseNumber(parsed.format?.bit_rate);
  const frameRate = parseFrameRate(video?.avg_frame_rate);
  return {
    ...(video?.width === undefined ? {} : { width: video.width }),
    ...(video?.height === undefined ? {} : { height: video.height }),
    ...(duration === undefined ? {} : { duration }),
    ...(video?.codec_name === undefined ? {} : { codec: video.codec_name }),
    ...(parsed.format?.format_name === undefined ? {} : { format: parsed.format.format_name }),
    ...(bitRate === undefined ? {} : { bitRate }),
    ...(frameRate === undefined ? {} : { frameRate }),
    hasAudio: audio !== undefined,
  };
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseFrameRate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!numerator || !denominator) return undefined;
  return numerator / denominator;
}

export async function probeVideo(
  path: string,
  ffprobe: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<VideoInfo> {
  const result = await runCommand(
    ffprobe,
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { ...(options.signal ? { signal: options.signal } : {}) },
  );
  checkCommand(result);
  return parseProbeOutput(result.stdout);
}

export interface WebmOptions {
  /** VP9 constant-quality value; lower is better/larger. */
  readonly crf: number;
  readonly maxWidth: number;
  readonly maxHeight?: number;
  readonly audio: "keep" | "strip";
  readonly audioBitrate: string;
}

export function defaultWebmOptions(): WebmOptions {
  return { crf: 32, maxWidth: 1920, audio: "keep", audioBitrate: "128k" };
}

export function targetDimensions(
  info: VideoInfo,
  maxWidth: number,
  maxHeight?: number,
): { readonly width: number; readonly height: number } | undefined {
  if (info.width === undefined || info.height === undefined) return undefined;
  const widthLimit = maxWidth > 0 ? maxWidth : info.width;
  const heightLimit = maxHeight !== undefined && maxHeight > 0 ? maxHeight : info.height;
  const scale = Math.min(1, widthLimit / info.width, heightLimit / info.height);
  if (scale >= 1) return undefined;
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(info.width * scale), height: even(info.height * scale) };
}

export interface WebmPlan {
  readonly input: string;
  readonly output: string;
  readonly info: VideoInfo;
  readonly args: readonly string[];
  readonly dimensions?: { readonly width: number; readonly height: number };
}

export interface WebmOutputOptions {
  readonly cwd: string;
  /** Explicit output file (single input only). */
  readonly out?: string;
  /** Output directory for batch conversions. */
  readonly outDir?: string;
  readonly overwrite?: boolean;
}

export async function planWebm(
  input: string,
  options: WebmOptions,
  ffprobePath: string,
  output: WebmOutputOptions,
  signal?: AbortSignal,
): Promise<WebmPlan> {
  const info = await probeVideo(input, ffprobePath, { ...(signal ? { signal } : {}) });
  const planned = await planOutputPath({
    input,
    cwd: output.cwd,
    extension: "webm",
    overwrite: output.overwrite ?? false,
    ...(output.out === undefined ? {} : { out: output.out }),
    ...(output.outDir === undefined ? {} : { outDir: output.outDir }),
  });
  if (resolve(planned) === resolve(input)) {
    throw new Error("Refusing to overwrite the input video; choose --out or --out-dir");
  }
  const dimensions = targetDimensions(info, options.maxWidth, options.maxHeight);
  return {
    input,
    output: planned,
    info,
    args: buildWebmArgs(input, planned, options, dimensions),
    ...(dimensions ? { dimensions } : {}),
  };
}

export function buildWebmArgs(
  input: string,
  output: string,
  options: WebmOptions,
  dimensions?: { readonly width: number; readonly height: number },
): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-map_metadata",
    "-1",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    String(options.crf),
    "-b:v",
    "0",
    "-row-mt",
    "1",
    "-deadline",
    "good",
    "-cpu-used",
    "2",
    "-pix_fmt",
    "yuv420p",
  ];
  if (dimensions) {
    args.push("-vf", `scale=${dimensions.width}:${dimensions.height}:flags=lanczos`);
  }
  if (options.audio === "strip") {
    args.push("-an");
  } else {
    args.push("-c:a", "libopus", "-b:a", options.audioBitrate);
  }
  args.push("-f", "webm", output);
  return args;
}

export interface WebmResult {
  readonly input: string;
  readonly output: string;
  readonly before: number;
  readonly after: number;
  readonly info: VideoInfo;
  readonly dimensions?: { readonly width: number; readonly height: number };
  readonly dryRun: boolean;
  readonly args: readonly string[];
}

export async function convertToWebm(
  input: string,
  options: WebmOptions,
  env: Readonly<Record<string, string | undefined>>,
  output: WebmOutputOptions,
  runOptions: { readonly signal?: AbortSignal; readonly dryRun?: boolean } = {},
): Promise<WebmResult> {
  const ffmpeg = requireBinary("ffmpeg", env, "Install it with `brew install ffmpeg` or `apt install ffmpeg`.");
  const ffprobe = requireBinary("ffprobe", env, "It ships with FFmpeg; install FFmpeg first.");
  const plan = await planWebm(input, options, ffprobe, output, runOptions.signal);
  const before = await fileSize(input);

  if (runOptions.dryRun) {
    return {
      input,
      output: plan.output,
      before,
      after: 0,
      info: plan.info,
      ...(plan.dimensions ? { dimensions: plan.dimensions } : {}),
      dryRun: true,
      args: plan.args,
    };
  }

  await ensureDirectory(dirname(plan.output));
  const temporary = join(
    dirname(plan.output),
    `.${basename(plan.output)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const args = plan.args.map((value) => (value === plan.output ? temporary : value));
  try {
    const result = await runCommand(ffmpeg, args, {
      cwd: output.cwd,
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    });
    if (result.code !== 0) throw new Error(commandError(result));
    await rename(temporary, plan.output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  return {
    input,
    output: plan.output,
    before,
    after: await fileSize(plan.output),
    info: plan.info,
    ...(plan.dimensions ? { dimensions: plan.dimensions } : {}),
    dryRun: false,
    args: plan.args,
  };
}
