import { lstat, readFile } from "node:fs/promises";

import { argument, cli, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, directories, files } from "../../kit/index.ts";
import { runBatch, sizeTotals } from "../../lib/batch.ts";
import { discoverFiles, displayPath, planOutputPath, readFileBytes, writeFileAtomic } from "../../lib/fs.ts";
import {
  extensionForFormat,
  IMAGE_EXTENSIONS,
  inspectImage,
  normalizeFormat,
  transformImage,
} from "../../lib/image.ts";
import {
  contentHash,
  executeFilePlan,
  type FileOperation,
  type OperationReceipt,
} from "../../lib/operations.ts";
import { color, formatBytes, formatSavings, json, plural, useColor } from "../../lib/output.ts";

interface WebResult {
  readonly input: string;
  readonly output: string;
  readonly before: number;
  readonly after: number;
  readonly width: number;
  readonly height: number;
  readonly skipped: boolean;
}

export const web = defineCommand(
  command(
    name("web"),
    description("Convert images to WebP for the web, resizing to a maximum width"),
    argument(
      name("files"),
      multiple(),
      description("Images or directories to process"),
      schema(z.array(z.string()).default([])),
      complete(files({ extensions: IMAGE_EXTENSIONS })),
    ),
    option(
      name("width"),
      cli(["--width", "-w"]),
      description("Maximum output width in pixels (no upscaling)"),
      schema(z.number().int().positive().default(1920)),
    ),
    option(
      name("quality"),
      cli(["--quality", "-q"]),
      description("WebP/AVIF quality (1-100, default: 82); explicitly setting it re-encodes existing images"),
      schema(z.number().int().min(1).max(100).optional()),
    ),
    option(
      name("format"),
      description("Output format"),
      schema(z.enum(["webp", "avif"]).default("webp")),
      complete([
        { value: "webp", description: "Broad browser support" },
        { value: "avif", description: "Smaller, slower to encode" },
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
    toggle(name("keepSize"), description("Keep original dimensions when converting or re-encoding")),
    toggle(name("reencode"), description("Re-encode images already in the target format")),
    toggle(name("record"), description("Record explicit outputs and replacement backups for sv undo")),
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
      if (discovered.files.length === 0) {
        throw new Error("No supported images found");
      }

      const format = model.format;
      const outputExtension = extensionForFormat(format);
      const reserved = new Set<string>();
      const plan: FileOperation[] = [];
      const publish = async (
        input: string,
        output: string,
        bytes: Uint8Array,
        source: Uint8Array,
        expected: Buffer | undefined,
      ) => {
        if (model.dryRun) return;
        context.signal.throwIfAborted();
        if (!model.record) {
          await writeFileAtomic(output, bytes, { overwrite: model.force });
          return;
        }
        if (input === output) throw new Error("--record preserves originals; choose a separate output");
        const inputs = [{ path: input, hash: contentHash(source) }];
        plan.push(
          expected === undefined
            ? { kind: "create", path: output, bytes, inputs }
            : { kind: "replace", path: output, bytes, expected, inputs },
        );
      };
      const batch = await runBatch(
        discovered.files,
        async (input): Promise<WebResult> => {
          const source = model.record ? await readFile(input) : Buffer.alloc(0);
          const info = await inspectImage(input);
          const sourceFormat = normalizeFormat(info.format);
          const needsResize = !model.keepSize && info.width > model.width;
          const needsReencode = sourceFormat !== format || model.reencode || model.quality !== undefined;
          const explicitOutput = model.out !== undefined || model.outDir !== undefined;
          if (!needsResize && !needsReencode && !explicitOutput) {
            return {
              input,
              output: input,
              before: info.bytes,
              after: info.bytes,
              width: info.width,
              height: info.height,
              skipped: true,
            };
          }

          const output = await planOutputPath({
            input,
            cwd: context.cwd,
            extension: outputExtension,
            overwrite: model.force,
            reserved,
            ...(model.out === undefined ? {} : { out: model.out }),
            ...(model.outDir === undefined ? {} : { outDir: model.outDir }),
          });
          const expected =
            model.record &&
            model.force &&
            (await lstat(output).then(
              () => true,
              (error: unknown) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
                throw error;
              },
            ))
              ? await readFile(output)
              : undefined;
          if (!needsResize && !needsReencode) {
            // Already in the target format: copy the bytes rather than
            // re-encoding and losing quality.
            if (!model.dryRun) {
              const bytes = await readFileBytes(input);
              context.signal.throwIfAborted();
              await publish(input, output, bytes, source, expected);
            }
            return {
              input,
              output,
              before: info.bytes,
              after: info.bytes,
              width: info.width,
              height: info.height,
              skipped: false,
            };
          }
          const result = await transformImage(input, {
            ...(model.keepSize ? {} : { resize: { width: model.width, withoutEnlargement: true } }),
            encode: { format, quality: model.quality ?? 82 },
          });
          if (!model.dryRun) {
            context.signal.throwIfAborted();
            await publish(input, output, result.data, source, expected);
          }
          return {
            input,
            output,
            before: info.bytes,
            after: result.bytes,
            width: result.width,
            height: result.height,
            skipped: false,
          };
        },
        (input) => input,
        {
          signal: context.signal,
          onStart(input, index, total) {
            context.log.debug(`web ${index + 1}/${total}: ${input}`);
          },
        },
      );

      let receipt: OperationReceipt | undefined;
      let recordError: string | undefined;
      if (model.record && !model.dryRun && plan.length > 0) {
        if (batch.failures.length > 0 || batch.aborted)
          recordError = "Recording aborted before writing because image planning failed";
        else {
          for (const op of plan) context.stderr.write(`${op.kind} ${displayPath(context.cwd, op.path)}\n`);
          try {
            receipt = await executeFilePlan(plan, context);
            if (receipt.status !== "applied") recordError = receipt.error ?? receipt.status;
          } catch (error) {
            recordError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      if (receipt) context.stderr.write(`Operation: ${receipt.id} (${receipt.status})\n`);
      if (recordError) context.stderr.write(`${recordError}\n`);
      for (const failure of batch.failures) {
        context.stderr.write(`${displayPath(context.cwd, failure.input)}: ${failure.error}\n`);
      }

      if (model.json) {
        const totals = sizeTotals(batch.results);
        context.stdout.write(
          json({
            command: "img web",
            ...(receipt ? { recordId: receipt.id, recordStatus: receipt.status } : {}),
            ...(recordError ? { recordError } : {}),
            dryRun: model.dryRun,
            files: batch.results.map((result) => ({
              input: displayPath(context.cwd, result.input),
              output: displayPath(context.cwd, result.output),
              before: result.before,
              after: result.after,
              width: result.width,
              height: result.height,
              skipped: result.skipped,
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
          const label = displayPath(context.cwd, result.input);
          if (result.skipped) {
            context.stdout.write(
              `${label}: already ${format}; skipped (use --reencode or --quality to re-encode)\n`,
            );
            continue;
          }
          const output = displayPath(context.cwd, result.output);
          const dimensions = `${result.width}×${result.height}`;
          context.stdout.write(
            `${label} → ${output}  ${formatBytes(result.before)} → ${formatBytes(result.after)} ` +
              `(${formatSavings(result.before, result.after)})  ${dimensions}\n`,
          );
        }
        const totals = sizeTotals(batch.results.filter((result) => !result.skipped));
        if (batch.results.length > 0) {
          context.stdout.write(
            `\n${color("Summary", "bold", useColour)}  ${batch.results.length} ${plural(
              batch.results.length,
              "file",
            )} · ${formatBytes(totals.before)} → ${formatBytes(totals.after)} (${formatSavings(
              totals.before,
              totals.after,
            )})${model.dryRun ? " · dry run" : ""}\n`,
          );
        }
      }

      if (batch.aborted) context.stderr.write("aborted\n");
      return recordError !== undefined ||
        batch.failures.length > 0 ||
        batch.aborted ||
        discovered.errors.length > 0 ||
        discovered.missing.length > 0 ||
        discovered.unsupported.length > 0
        ? 1
        : 0;
    },
  },
);
