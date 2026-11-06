import { argument, cli, command, description, name, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { defineCommand } from "../kit/index.ts";
import { undoOperation } from "../lib/operations.ts";
import { json } from "../lib/output.ts";

export const undo = defineCommand(
  command(
    name("undo"),
    description("Cautiously undo a recorded file operation"),
    argument(name("id"), schema(z.string())),
    toggle(name("dryRun"), description("Validate and preview without writing")),
    toggle(name("yes"), description("Apply without prompting"), cli(["--yes"], { switch: true })),
    toggle(name("json"), description("Print machine-readable JSON; apply requires --yes")),
  ),
  {
    async run({ model }, context: AppContext) {
      const preview = await undoOperation(model.id, { ...context, dryRun: true });
      if (!model.json) {
        context.stdout.write(`Undo ${preview.id}:\n`);
        for (const file of preview.files.filter(
          (file) => file.status === "applied" || file.status === "applying",
        ))
          context.stdout.write(`  ${file.kind === "create" ? "delete" : "restore"} ${file.path}\n`);
      }
      if (model.dryRun) {
        if (model.json) context.stdout.write(json({ dryRun: true, receipt: preview }));
        return 0;
      }
      if (!model.yes && (model.json || !(await context.confirm("Apply this undo?"))))
        throw new Error("Use --yes to apply undo without interactive confirmation");
      const receipt = await undoOperation(preview.id, context);
      if (model.json) context.stdout.write(json({ dryRun: false, receipt }));
      else context.stdout.write(`${receipt.id}: ${receipt.status}\n`);
      return receipt.status === "undone" ? 0 : 1;
    },
  },
);
