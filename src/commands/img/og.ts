import { argument, cli, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, directories, files } from "../../kit/index.ts";
import { runBatch, sizeTotals } from "../../lib/batch.ts";
import { discoverFiles, displayPath, planOutputPath, writeFileAtomic } from "../../lib/fs.ts";
import {
  formatDimensions,
  IMAGE_EXTENSIONS,
  inspectImage,
  parseDimensions,
  transformImage,
} from "../../lib/image.ts";
import { color, formatBytes, formatSavings, json, useColor } from "../../lib/output.ts";

interface OgResult {
  readonly input: string;
  readonly output: string;
  readonly before: number;
  readonly after: number;
  readonly width: number;
  readonly height: number;
  readonly matchesTarget: boolean;
  readonly target: { readonly width: number; readonly height: number };
}

export const og = defineCommand(
  command(
    name("og"),
    description("Optimize OpenGraph/cover images while preserving PNG by default"),
    argument(
      name("files"),
      multiple(),
      description("Images or directories to process"),
      schema(z.array(z.string()).default([])),
      complete(files({ extensions: IMAGE_EXTENSIONS })),
    ),
    option(
      name("target"),
      description("Expected cover dimensions, e.g. 1920x1080"),
      schema(z.string().default("1920x1080")),
      complete(["1200x630", "1920x1080", "1200x1200"]),
    ),
    option(
      name("resize"),
      description("Explicitly resize to WIDTHxHEIGHT (off by default)"),
      schema(z.string().optional()),
      complete(["1920x1080", "1200x630"]),
    ),
    option(
      name("fit"),
      description("How --resize fits the image: inside, cover, contain or fill"),
      schema(z.enum(["inside", "cover", "contain", "fill"]).default("inside")),
      complete([
        { value: "inside", description: "Fit inside, no padding" },
        { value: "cover", description: "Fill and crop" },
        { value: "contain", description: "Fit and pad" },
        { value: "fill", description: "Force exact size (may distort)" },
      ]),
    ),
    option(
      name("background"),
      description("Padding colour for --fit contain"),
      schema(z.string().optional()),
    ),
    option(
      name("quality"),
      cli(["--quality", "-q"]),
      description("JPEG quality, or PNG quality with --palette (1-100)"),
      schema(z.number().int().min(1).max(100).default(85)),
    ),
    option(
      name("format"),
      description("Output format (PNG is the default for covers)"),
      schema(z.enum(["png", "jpeg"]).default("png")),
      complete([
        { value: "png", description: "Lossless cover, broad support" },
        { value: "jpeg", description: "Smaller photographic covers" },
      ]),
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
    toggle(name("strict"), description("Exit non-zero when dimensions do not match --target")),
    toggle(name("palette"), description("Quantize PNG colours for smaller, lossy palette output")),
    toggle(name("force"), description("Overwrite existing output files")),
    toggle(name("dryRun"), description("Show what would be written without writing")),
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

      const target = parseDimensions(model.target);
      const resize = model.resize === undefined ? undefined : parseDimensions(model.resize);
      const background = model.background ?? (model.format === "png" ? "#00000000" : "#ffffff");
      const discovered = await discoverFiles(model.files, {
        cwd: context.cwd,
        extensions: IMAGE_EXTENSIONS,
        respectGitIgnore: true,
      });
      for (const path of discovered.missing)
        context.stderr.write(`missing: ${displayPath(context.cwd, path)}\n`);
      for (const path of discovered.unsupported) {
        context.stderr.write(`unsupported: ${displayPath(context.cwd, path)}\n`);
      }
      for (const failure of discovered.errors) {
        context.stderr.write(`${displayPath(context.cwd, failure.path)}: ${failure.error}\n`);
      }
      if (model.out !== undefined && discovered.files.length > 1) {
        throw new Error("--out can only be used with a single input; use --out-dir for batches");
      }
      if (discovered.files.length === 0) throw new Error("No supported images found");

      const reserved = new Set<string>();
      const batch = await runBatch(
        discovered.files,
        async (input): Promise<OgResult> => {
          const info = await inspectImage(input);
          const output = await planOutputPath({
            input,
            cwd: context.cwd,
            extension: model.format === "jpeg" ? "jpg" : "png",
            overwrite: model.force,
            reserved,
            ...(model.out === undefined ? {} : { out: model.out }),
            ...(model.outDir === undefined ? {} : { outDir: model.outDir }),
          });
          const result = await transformImage(input, {
            ...(resize === undefined
              ? {}
              : {
                  resize: {
                    width: resize.width,
                    height: resize.height,
                    fit: model.fit,
                    background,
                    withoutEnlargement: false,
                  },
                }),
            encode: {
              format: model.format,
              quality: model.quality,
              ...(model.format === "png" ? { palette: model.palette } : {}),
            },
          });
          if (!model.dryRun) {
            context.signal.throwIfAborted();
            await writeFileAtomic(output, result.data, { overwrite: model.force });
          }
          return {
            input,
            output,
            before: info.bytes,
            after: result.bytes,
            width: result.width,
            height: result.height,
            matchesTarget: result.width === target.width && result.height === target.height,
            target,
          };
        },
        (input) => input,
        {
          signal: context.signal,
          onStart(input, index, total) {
            context.log.debug(`og ${index + 1}/${total}: ${input}`);
          },
        },
      );

      for (const failure of batch.failures) {
        context.stderr.write(`${displayPath(context.cwd, failure.input)}: ${failure.error}\n`);
      }

      const mismatches = batch.results.filter((result) => !result.matchesTarget);
      if (model.json) {
        const totals = sizeTotals(batch.results);
        context.stdout.write(
          json({
            command: "img og",
            dryRun: model.dryRun,
            target,
            files: batch.results.map((result) => ({
              input: displayPath(context.cwd, result.input),
              output: displayPath(context.cwd, result.output),
              before: result.before,
              after: result.after,
              width: result.width,
              height: result.height,
              matchesTarget: result.matchesTarget,
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
              )})  ${formatDimensions(result.width, result.height)}\n`,
          );
          if (!result.matchesTarget) {
            context.stderr.write(
              `${color("warning", "yellow", useColour)}: ${displayPath(context.cwd, result.input)} is ` +
                `${formatDimensions(result.width, result.height)}, target is ${formatDimensions(
                  target.width,
                  target.height,
                )}\n`,
            );
          }
        }
        const totals = sizeTotals(batch.results);
        if (batch.results.length > 0) {
          context.stdout.write(
            `\n${color("Summary", "bold", useColour)}  ${batch.results.length} file(s) · ` +
              `${formatBytes(totals.before)} → ${formatBytes(totals.after)} (${formatSavings(
                totals.before,
                totals.after,
              )})${model.dryRun ? " · dry run" : ""}\n`,
          );
        }
      }

      if (batch.aborted) context.stderr.write("aborted\n");
      const failed =
        batch.failures.length > 0 ||
        batch.aborted ||
        discovered.errors.length > 0 ||
        discovered.missing.length > 0 ||
        discovered.unsupported.length > 0 ||
        (model.strict && mismatches.length > 0);
      return failed ? 1 : 0;
    },
  },
);
