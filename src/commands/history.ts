import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { argument, command, description, name, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import { defineCommand } from "../kit/index.ts";
import { displayPath } from "../lib/fs.ts";
import { readHistory } from "../lib/operations.ts";
import { json, plural, shellCommand } from "../lib/output.ts";

export const history = defineCommand(
  command(
    name("history"),
    description("List local file operation receipts or inspect one"),
    argument(name("id"), description("Optional receipt id or last"), schema(z.string().optional())),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context) {
      const program = ["sv", ...(resolve(context.cwd) === process.cwd() ? [] : ["--cwd", context.cwd])];
      const receipts = await readHistory(context);
      const selected =
        model.id === undefined
          ? receipts
          : model.id === "last"
            ? receipts.slice(0, 1)
            : receipts.filter((receipt) => receipt.id === model.id);
      if (model.id !== undefined && selected.length === 0)
        throw new Error(`No operation receipt: ${model.id}`);
      if (model.json) context.stdout.write(json(model.id === undefined ? selected : selected[0]));
      else {
        context.stdout.write(`History: ${JSON.stringify(await realpath(context.cwd))}\n`);
        if (selected.length === 0)
          context.stdout.write(
            "No recorded operations in this directory.\nUse sv ready <path> --yes or sv img web <image> --record to create an undo receipt.\nHistory is scoped to the working directory; use sv --cwd <directory> history for another project.\n",
          );
        for (const receipt of selected) {
          context.stdout.write(
            `${receipt.id}  ${receipt.status}  ${receipt.createdAt}  ${receipt.files.length} ${plural(receipt.files.length, "file operation")}\n`,
          );
          if (model.id)
            for (const file of receipt.files)
              context.stdout.write(
                `  ${file.kind} ${JSON.stringify(displayPath(context.cwd, file.path))} (${file.status})\n`,
              );
        }
        if (!model.id && selected.length)
          context.stdout.write(
            `Inspect with: ${shellCommand([...program, "history", "last"])}\nPreview undo with: ${shellCommand([...program, "undo", "last", "--dry-run"])}\n`,
          );
      }
    },
  },
);
