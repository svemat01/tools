import { argument, command, description, name, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import { complete, defineCommand, files } from "../kit/index.ts";
import { inspectPath } from "../lib/inspect.ts";
import { json } from "../lib/output.ts";

export const inspect = defineCommand(
  command(
    name("inspect"),
    description("Inspect a local file or bounded directory sample without writing"),
    argument(name("path"), schema(z.string()), complete(files())),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context) {
      const result = await inspectPath(model.path, context);
      if (model.json) context.stdout.write(json({ command: "inspect", schemaVersion: 1, result }));
      else {
        context.stdout.write(`${result.path}: ${result.kind}\n`);
        if (result.kind === "error") context.stderr.write(`${result.message}\n`);
        else {
          if ("bytes" in result) context.stdout.write(`  ${result.bytes} bytes\n`);
          if ("metadata" in result) context.stdout.write(`${json(result.metadata)}`);
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
