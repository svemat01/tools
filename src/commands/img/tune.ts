import { pathToFileURL } from "node:url";

import { argument, command, description, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, files } from "../../kit/index.ts";
import { displayPath, planOutputPath, resolvePath, writeFileAtomic } from "../../lib/fs.ts";
import { buildImageTuneReport, TUNE_LIMITS } from "../../lib/image-tune.ts";
import { openLocalFile } from "../../lib/open.ts";
import { json } from "../../lib/output.ts";
import { createProgressReporter } from "../../lib/progress.ts";

export const tune = defineCommand(
  command(
    name("tune"),
    description("Export an offline visual quality review with embedded image downloads"),
    argument(
      name("input"),
      schema(z.string()),
      complete(files({ extensions: ["png", "jpg", "jpeg", "webp", "avif", "gif", "tiff"] })),
    ),
    option(
      name("width"),
      description("Maximum width; no upscaling (default 1600, maximum 2560)"),
      schema(z.number().int().min(1).max(TUNE_LIMITS.width).default(1600)),
    ),
    option(
      name("qualities"),
      description("1-5 distinct quality values, comma-separated (default 60,75,85)"),
      schema(z.string().default("60,75,85")),
    ),
    option(name("format"), schema(z.enum(["webp", "avif"]).default("webp")), complete(["webp", "avif"])),
    option(
      name("out"),
      description("Report path; existing names receive a safe numeric suffix"),
      schema(z.string().optional()),
      complete(files()),
    ),
    toggle(name("open"), description("Open the saved report with your local default application")),
    toggle(name("json"), description("Print report path and variant metadata as JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      const progress = createProgressReporter(context.stderr, { cwd: context.cwd, enabled: !model.json });
      try {
        const input = resolvePath(context.cwd, model.input);
        const output = await planOutputPath({
          input,
          cwd: context.cwd,
          extension: "html",
          suffix: "-review",
          reserved: new Set<string>(),
          ...(model.out === undefined ? {} : { out: model.out }),
        });
        if (!output.toLowerCase().endsWith(".html"))
          throw new Error("Tune report output must have an .html extension");
        const values = model.qualities.split(",");
        if (values.some((value) => !/^\s*\d{1,3}\s*$/.test(value)))
          throw new Error("Qualities must be comma-separated integers from 1 to 100");
        const { html, review } = await buildImageTuneReport(input, {
          width: model.width,
          qualities: values.map(Number),
          format: model.format,
          signal: context.signal,
          onProgress: progress.report,
        });
        context.signal.throwIfAborted();
        progress.report({ phase: "apply", path: output });
        await writeFileAtomic(output, Buffer.from(html));
        progress.finish();
        const opened = model.open
          ? await openLocalFile(output, { env: context.env, signal: context.signal })
          : false;
        if (model.open && !opened)
          context.stderr.write(
            "Report saved, but the local application could not be opened. Use the report URL below.\n",
          );
        const report = displayPath(context.cwd, output);
        if (model.json)
          context.stdout.write(
            json({
              command: "img tune",
              report,
              reportUrl: pathToFileURL(output).href,
              openRequested: model.open,
              opened,
              source: { filename: review.filename, ...review.source },
              variants: review.variants.map(({ url: _url, ...variant }) => variant),
            }),
          );
        else
          context.stdout.write(
            `Image review: ${report}\n${review.variants.length} ${model.format.toUpperCase()} variants · ${review.reference.width}×${review.reference.height}\nOpen report: ${pathToFileURL(output).href}\n${opened ? "Opened with your default application.\n" : "Compare qualities, download an image, or copy its conversion command in the report.\n"}`,
          );
        return 0;
      } catch (error) {
        progress.finish(context.signal.aborted ? "cancelled" : "failed");
        throw error;
      }
    },
  },
);
