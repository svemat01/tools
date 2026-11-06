import { argument, cli, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, directories, files } from "../../kit/index.ts";
import { runBatch, sizeTotals } from "../../lib/batch.ts";
import { discoverFiles, displayPath, planOutputPath, writeFileAtomic } from "../../lib/fs.ts";
import {
  extensionForFormat,
  type Fit,
  IMAGE_EXTENSIONS,
  inspectImage,
  normalizeFormat,
  transformImage,
} from "../../lib/image.ts";
import { color, formatBytes, formatSavings, json, useColor } from "../../lib/output.ts";

interface ResizeResult {
  readonly input: string;
  readonly output: string;
  readonly before: number;
  readonly after: number;
  readonly width: number;
  readonly height: number;
}

export const resize = defineCommand(
  command(
    name("resize"),
    description("Resize images with aspect-ratio-aware fitting and no upscaling by default"),
    argument(
      name("files"),
      multiple(),
      description("Images or directories to resize"),
      schema(z.array(z.string()).default([])),
      complete(files({ extensions: IMAGE_EXTENSIONS })),
    ),
    option(
      name("width"),
      cli(["--width", "-w"]),
      description("Target width in pixels"),
      schema(z.number().int().positive().optional()),
    ),
    option(
      name("height"),
      description("Target height in pixels"),
      schema(z.number().int().positive().optional()),
    ),
    option(
      name("fit"),
      description("inside, cover, contain or fill"),
      schema(z.enum(["inside", "cover", "contain", "fill"]).default("inside")),
      complete([
        { value: "inside", description: "Fit inside, preserve aspect" },
        { value: "cover", description: "Fill and crop" },
        { value: "contain", description: "Fit and pad" },
        { value: "fill", description: "Force exact size (may distort)" },
      ]),
    ),
    option(
      name("background"),
      description("Padding colour for --fit contain"),
      schema(z.string().default("#00000000")),
    ),
    option(
      name("format"),
      description("Output format (defaults to the input format)"),
      schema(z.enum(["png", "jpeg", "webp", "avif", "gif", "tiff"]).optional()),
      complete(["png", "jpeg", "webp", "avif", "gif", "tiff"]),
    ),
    option(
      name("quality"),
      cli(["--quality", "-q"]),
      description("Output quality for lossy formats (1-100)"),
      schema(z.number().int().min(1).max(100).default(82)),
    ),
    option(
      name("suffix"),
      description("Suffix for copies in the same directory (default _resized)"),
      schema(z.string().optional()),
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
    toggle(name("allowUpscale"), description("Allow enlarging images")),
    toggle(name("force"), description("Overwrite existing output files")),
    toggle(name("dryRun"), description("Show what would be written without writing")),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      if (model.width === undefined && model.height === undefined) {
        throw new Error("Provide --width and/or --height");
      }
      if (model.out !== undefined && model.files.length > 1) {
        throw new Error("--out can only be used with a single input; use --out-dir for batches");
      }
      if (model.out !== undefined && model.outDir !== undefined) {
        throw new Error("Use either --out or --out-dir, not both");
      }

      const suffix =
        model.suffix ?? (model.out === undefined && model.outDir === undefined ? "_resized" : "");
      const discovered = await discoverFiles(model.files, {
        cwd: context.cwd,
        extensions: IMAGE_EXTENSIONS,
        respectGitIgnore: true,
      });
      for (const failure of discovered.errors) {
        context.stderr.write(`${displayPath(context.cwd, failure.path)}: ${failure.error}\n`);
      }
      for (const path of discovered.missing)
        context.stderr.write(`missing: ${displayPath(context.cwd, path)}\n`);
      for (const path of discovered.unsupported) {
        context.stderr.write(`unsupported: ${displayPath(context.cwd, path)}\n`);
      }
      if (model.out !== undefined && discovered.files.length > 1) {
        throw new Error("--out can only be used with a single input; use --out-dir for batches");
      }
      if (discovered.files.length === 0) throw new Error("No supported images found");

      const reserved = new Set<string>();
      const batch = await runBatch(
        discovered.files,
        async (input): Promise<ResizeResult> => {
          const info = await inspectImage(input);
          const inputFormat = normalizeFormat(model.format ?? info.format);
          if (!inputFormat) {
            throw new Error(
              `Unsupported output format ${model.format ?? info.format}; pass --format explicitly`,
            );
          }
          const output = await planOutputPath({
            input,
            cwd: context.cwd,
            extension: extensionForFormat(inputFormat),
            suffix,
            overwrite: model.force,
            reserved,
            ...(model.out === undefined ? {} : { out: model.out }),
            ...(model.outDir === undefined ? {} : { outDir: model.outDir }),
          });
          const result = await transformImage(input, {
            resize: {
              ...(model.width === undefined ? {} : { width: model.width }),
              ...(model.height === undefined ? {} : { height: model.height }),
              fit: model.fit as Fit,
              withoutEnlargement: !model.allowUpscale,
              background: model.background,
            },
            encode: {
              format: inputFormat,
              quality: model.quality,
              ...(inputFormat === "png" ? { palette: false } : {}),
            },
          });
          if (context.signal.aborted) throw new Error("aborted");
          if (!model.dryRun) await writeFileAtomic(output, result.data, { overwrite: model.force });
          return {
            input,
            output,
            before: info.bytes,
            after: result.bytes,
            width: result.width,
            height: result.height,
          };
        },
        (input) => input,
        {
          signal: context.signal,
          onStart(input, index, total) {
            context.log.debug(`resize ${index + 1}/${total}: ${input}`);
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
            command: "img resize",
            dryRun: model.dryRun,
            files: batch.results.map((result) => ({
              input: displayPath(context.cwd, result.input),
              output: displayPath(context.cwd, result.output),
              before: result.before,
              after: result.after,
              width: result.width,
              height: result.height,
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
          context.stdout.write(
            `${displayPath(context.cwd, result.input)} → ${displayPath(context.cwd, result.output)}  ` +
              `${formatBytes(result.before)} → ${formatBytes(result.after)} (${formatSavings(
                result.before,
                result.after,
              )})  ${result.width}×${result.height}\n`,
          );
        }
        const totals = sizeTotals(batch.results);
        if (batch.results.length > 0) {
          context.stdout.write(
            `\n${color("Summary", "bold", useColour)}  ${batch.results.length} file(s) · ` +
              `${formatBytes(totals.before)} → ${formatBytes(totals.after)}${model.dryRun ? " · dry run" : ""}\n`,
          );
        }
      }

      if (batch.aborted) context.stderr.write("aborted\n");
      return batch.failures.length > 0 ||
        batch.aborted ||
        discovered.errors.length > 0 ||
        discovered.missing.length > 0 ||
        discovered.unsupported.length > 0
        ? 1
        : 0;
    },
  },
);
