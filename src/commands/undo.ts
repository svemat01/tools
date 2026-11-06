import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { argument, cli, command, description, name, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { defineCommand } from "../kit/index.ts";
import { displayPath } from "../lib/fs.ts";
import { contentHash, undoOperation } from "../lib/operations.ts";
import { json, plural, shellCommand } from "../lib/output.ts";

export const undo = defineCommand(
  command(
    name("undo"),
    description("Cautiously undo a recorded file operation"),
    argument(name("id"), description("Receipt id or last"), schema(z.string())),
    toggle(name("dryRun"), description("Validate and preview without writing")),
    toggle(name("yes"), description("Apply without prompting"), cli(["--yes"], { switch: true })),
    toggle(name("json"), description("Print machine-readable JSON; apply requires --yes")),
  ),
  {
    async run({ model }, context: AppContext) {
      const program = ["sv", ...(resolve(context.cwd) === process.cwd() ? [] : ["--cwd", context.cwd])];
      const preview = await undoOperation(model.id, { ...context, dryRun: true });
      const changes: { action: "delete" | "restore"; path: string }[] = [];
      for (const file of preview.files) {
        if (file.status !== "applied" && file.status !== "applying") continue;
        if (file.status === "applying") {
          // The journal is saved before publication. A failed create may have
          // no output, and a failed replacement may still contain its original.
          if (file.kind === "create") {
            try {
              await lstat(file.path);
            } catch (error) {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
              throw error;
            }
          }
          if (file.kind === "replace" && contentHash(await readFile(file.path)) === file.beforeHash) continue;
        }
        changes.push({ action: file.kind === "create" ? "delete" : "restore", path: file.path });
      }
      if (!model.json) {
        context.stdout.write(
          `Undo ${preview.id}: ${changes.length} ${plural(changes.length, "file change")}\n`,
        );
        for (const change of changes)
          context.stdout.write(
            `  ${change.action} ${JSON.stringify(displayPath(context.cwd, change.path))}\n`,
          );
      }
      if (model.dryRun || changes.length === 0) {
        // Finish an interrupted operation with no published mutations, so
        // `undo last` can advance to the previous operation. Dry runs remain
        // entirely read-only; JSON cannot apply even this bookkeeping without --yes.
        const receipt =
          !model.dryRun && changes.length === 0 && preview.status !== "undone" && (model.yes || !model.json)
            ? await undoOperation(preview.id, context)
            : preview;
        if (model.json) context.stdout.write(json({ dryRun: model.dryRun, changes, receipt }));
        else
          context.stdout.write(
            changes.length
              ? `Preview only; no files changed. Apply with: ${shellCommand([...program, "undo", preview.id, "--yes"])}\n`
              : "Nothing to undo; no files changed.\n",
          );
        return 0;
      }
      if (!model.yes && (model.json || !(await context.confirm("Apply this undo?"))))
        throw new Error("Use --yes to apply undo without interactive confirmation");
      const receipt = await undoOperation(preview.id, context);
      if (model.json) context.stdout.write(json({ dryRun: false, changes, receipt }));
      else context.stdout.write(`${receipt.id}: ${receipt.status}\n`);
      return receipt.status === "undone" ? 0 : 1;
    },
  },
);
