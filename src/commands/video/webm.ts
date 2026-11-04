import { argument, cli, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, directories, files } from "../../kit/index.ts";
import { runBatch, sizeTotals } from "../../lib/batch.ts";
import { discoverFiles, displayPath } from "../../lib/fs.ts";
import { color, formatBytes, formatSavings, json, plural, useColor } from "../../lib/output.ts";
import { requireBinary } from "../../lib/process.ts";
import { convertToWebm, VIDEO_EXTENSIONS, type WebmResult } from "../../lib/video.ts";

export const webm = defineCommand(
  command(
    name("webm"),
    description("Convert videos to efficient WebM/VP9 without upscaling"),
    argument(
      name("files"),
      multiple(),
      description("Videos or directories to convert"),
      schema(z.array(z.string()).default([])),
      complete(files({ extensions: [...VIDEO_EXTENSIONS] })),
    ),
    option(
      name("crf"),
      description("VP9 constant quality (0-63; lower is better and larger)"),
      schema(z.number().int().min(0).max(63).default(32)),
    ),
    option(
      name("width"),
      cli(["--width", "-w"]),
      description("Maximum output width in pixels (no upscaling)"),
      schema(z.number().int().positive().default(1920)),
    ),
    option(
      name("height"),
      description("Optional maximum output height in pixels"),
      schema(z.number().int().positive().optional()),
    ),
    toggle(name("keepSize"), description("Keep the source dimensions; only re-encode")),
    option(
      name("audio"),
      description("Keep or strip the audio track"),
      schema(z.enum(["keep", "strip"]).default("keep")),
      complete([
        { value: "keep", description: "Encode audio as Opus" },
        { value: "strip", description: "Drop the audio track" },
      ]),
    ),
    option(
      name("audioBitrate"),
      description("Opus audio bitrate when audio is kept"),
      schema(z.string().default("128k")),
    ),
    option(
      name("out"),
      cli(["--out", "-o"]),
      description("Explicit output file (single input only)"),
      schema(z.string().optional()),
      complete(files()),
    ),
    option(
      name("outDir"),
      description("Output directory for all results"),
      schema(z.string().optional()),
      complete(directories()),
    ),
    toggle(name("force"), description("Overwrite existing output files")),
    toggle(name("dryRun"), description("Probe inputs and print the plan without encoding")),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      if (model.out !== undefined && model.files.length > 1) {
        throw new Error("--out can only be used with a single input; use --out-dir for batches");
      }
      if (model.out !== undefined && model.outDir !== undefined) {
        throw new Error("Use either --out or --out-dir, not both");
      }

      // Fail before walking a large directory when the encoder is missing.
      requireBinary("ffmpeg", context.env, "Install it with `brew install ffmpeg` or `apt install ffmpeg`.");
      requireBinary("ffprobe", context.env, "It ships with FFmpeg; install FFmpeg first.");

      const discovered = await discoverFiles(model.files, {
        cwd: context.cwd,
        extensions: [...VIDEO_EXTENSIONS],
        respectGitIgnore: true,
      });
      for (const path of discovered.missing)
        context.stderr.write(`missing: ${displayPath(context.cwd, path)}\n`);
      for (const path of discovered.unsupported) {
        context.stderr.write(`unsupported: ${displayPath(context.cwd, path)}\n`);
      }
      if (model.out !== undefined && discovered.files.length > 1) {
        throw new Error("--out can only be used with a single input; use --out-dir for batches");
      }
      if (discovered.files.length === 0) throw new Error("No supported videos found");

      const batch = await runBatch(
        discovered.files,
        (input): Promise<WebmResult> =>
          convertToWebm(
            input,
            {
              crf: model.crf,
              maxWidth: model.keepSize ? 0 : model.width,
              ...(model.keepSize || model.height === undefined ? {} : { maxHeight: model.height }),
              audio: model.audio,
              audioBitrate: model.audioBitrate,
            },
            context.env,
            {
              cwd: context.cwd,
              overwrite: model.force,
              ...(model.out === undefined ? {} : { out: model.out }),
              ...(model.outDir === undefined ? {} : { outDir: model.outDir }),
            },
            { signal: context.signal, dryRun: model.dryRun },
          ),
        (input) => input,
        {
          signal: context.signal,
          onStart(input, index, total) {
            context.log.debug(`webm ${index + 1}/${total}: ${input}`);
          },
        },
      );

      for (const failure of batch.failures) {
        context.stderr.write(`${displayPath(context.cwd, failure.input)}: ${failure.error}\n`);
      }

      if (model.json) {
        const totals = sizeTotals(batch.results);
        context.stdout.write(
          json({
            command: "video webm",
            dryRun: model.dryRun,
            crf: model.crf,
            files: batch.results.map((result) => ({
              input: displayPath(context.cwd, result.input),
              output: displayPath(context.cwd, result.output),
              before: result.before,
              after: result.after,
              width: result.info.width,
              height: result.info.height,
              outputWidth: result.dimensions?.width,
              outputHeight: result.dimensions?.height,
              duration: result.info.duration,
              audio: result.info.hasAudio,
            })),
            failures: batch.failures.map((failure) => ({
              input: displayPath(context.cwd, failure.input),
              error: failure.error,
            })),
            totals,
            aborted: batch.aborted,
          }),
        );
      } else {
        const useColour = useColor(context.stdout, context.env);
        for (const result of batch.results) {
          const dimensions =
            result.dimensions === undefined
              ? "unchanged"
              : `${result.info.width}×${result.info.height} → ${result.dimensions.width}×${result.dimensions.height}`;
          const size = result.dryRun
            ? `${formatBytes(result.before)} → (not encoded)`
            : `${formatBytes(result.before)} → ${formatBytes(result.after)} (${formatSavings(
                result.before,
                result.after,
              )})`;
          context.stdout.write(
            `${displayPath(context.cwd, result.input)} → ${displayPath(context.cwd, result.output)}  ` +
              `${size}  ${dimensions}  crf ${model.crf}\n`,
          );
        }
        const totals = sizeTotals(batch.results.filter((result) => !result.dryRun));
        if (batch.results.length > 0) {
          const summary = model.dryRun
            ? `${batch.results.length} ${plural(batch.results.length, "video")} · ` +
              `${formatBytes(batch.results.reduce((total, result) => total + result.before, 0))} input · dry run`
            : `${batch.results.length} ${plural(batch.results.length, "video")} · ` +
              `${formatBytes(totals.before)} → ${formatBytes(totals.after)}`;
          context.stdout.write(`\n${color("Summary", "bold", useColour)}  ${summary}\n`);
        }
      }

      if (batch.aborted) context.stderr.write("aborted\n");
      return batch.failures.length > 0 ||
        batch.aborted ||
        discovered.missing.length > 0 ||
        discovered.unsupported.length > 0
        ? 1
        : 0;
    },
  },
);
