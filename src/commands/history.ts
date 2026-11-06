import { argument, command, description, name, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import { defineCommand } from "../kit/index.ts";
import { readHistory } from "../lib/operations.ts";
import { json } from "../lib/output.ts";

export const history = defineCommand(
  command(
    name("history"),
    description("List local file operation receipts or inspect one"),
    argument(name("id"), schema(z.string().optional())),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context) {
      const receipts = await readHistory(context);
      const selected =
        model.id === undefined ? receipts : receipts.filter((receipt) => receipt.id === model.id);
      if (model.id !== undefined && selected.length === 0)
        throw new Error(`No operation receipt: ${model.id}`);
      if (model.json) context.stdout.write(json(model.id === undefined ? selected : selected[0]));
      else
        for (const receipt of selected) {
          context.stdout.write(`${receipt.id}  ${receipt.status}  ${receipt.createdAt}\n`);
          if (model.id)
            for (const file of receipt.files)
              context.stdout.write(`  ${file.kind} ${file.path} (${file.status})\n`);
        }
    },
  },
);
