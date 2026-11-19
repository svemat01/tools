import { argument, command, description, name, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import { complete, defineCommand, files } from "../kit/index.ts";
import { displayPath } from "../lib/fs.ts";
import { inspectPath } from "../lib/inspect.ts";
import { formatBytes, json } from "../lib/output.ts";

export const inspect = defineCommand(
  command(
    name("inspect"),
    description("Inspect a local file or bounded directory sample without writing"),
    argument(
      name("path"),
      description("Local file or directory to inspect"),
      schema(z.string()),
      complete(files()),
    ),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context) {
      const result = await inspectPath(model.path, context);
      if (model.json) context.stdout.write(json({ command: "inspect", schemaVersion: 1, result }));
      else {
        context.stdout.write(`${displayPath(context.cwd, result.path)}: ${result.kind}\n`);
        if (result.kind === "error") context.stderr.write(`${result.message}\n`);
        else {
          if ("bytes" in result) context.stdout.write(`  Size: ${formatBytes(result.bytes)}\n`);
          if (result.kind === "image" || result.kind === "video") {
            if (result.metadata.status === "unavailable") {
              context.stdout.write(
                `  Metadata unavailable: ${result.metadata.reason}\n  ${result.metadata.action}\n`,
              );
            } else if (result.kind === "image" && result.metadata.status === "available") {
              const info = result.metadata.value;
              const rotated = (info.orientation ?? 1) >= 5;
              context.stdout.write(
                `  ${info.format.toUpperCase()} · ${rotated ? info.height : info.width}×${rotated ? info.width : info.height}${info.animated ? ` · ${info.pages} frames/pages` : ""}${info.hasAlpha ? " · transparency" : ""}\n`,
              );
            } else if (result.kind === "video" && result.metadata.status === "available") {
              const info = result.metadata.value;
              context.stdout.write(
                `  ${info.codec ?? "Unknown codec"}${info.width && info.height ? ` · ${info.width}×${info.height}` : ""}${info.duration === undefined ? "" : ` · ${info.duration.toFixed(1)} seconds`} · ${info.hasAudio ? "with audio" : "no audio"}\n`,
              );
            }
          } else if (result.kind === "markdown") {
            context.stdout.write(
              `  Title: ${result.metadata.title ?? "No H1 heading found"}${result.metadata.truncated ? " (sampled first 64 KiB)" : ""}\n`,
            );
          }
          if ("summary" in result) {
            context.stdout.write(
              `  ${result.summary.entries.length} visible entries; ${result.summary.skipped} skipped${result.summary.truncated ? "; sample limit reached" : ""}\n`,
            );
            for (const entry of result.summary.entries)
              context.stdout.write(`  ${entry.kind}: ${entry.name}\n`);
          }
          for (const suggestion of result.suggestions) context.stdout.write(`  Try: ${suggestion.command}\n`);
        }
      }
      return result.kind === "error" ? 1 : 0;
    },
  },
);
