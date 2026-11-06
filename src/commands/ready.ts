import { argument, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { complete, defineCommand, directories, files } from "../kit/index.ts";
import { json } from "../lib/output.ts";
import { applyReady, inspectReady, planReady } from "../lib/ready.ts";

export const ready = defineCommand(
  command(
    name("ready"),
    description("Preview local content preparation; apply new image outputs with undo history"),
    argument(name("paths"), multiple(), schema(z.array(z.string()).default([])), complete(files())),
    toggle(name("changed"), description("Select staged, unstaged and untracked files in Git")),
    toggle(name("apply"), description("Confirm application after the full preview")),
    toggle(name("yes"), description("Authorize application without prompting")),
    toggle(name("dryRun"), description("Preview only, even with --apply or --yes")),
    toggle(name("review"), description("Plan an offline HTML review for each applied image")),
    option(
      name("outDir"),
      description("Output directory (default .sv-ready); excluded from discovery"),
      schema(z.string().optional()),
      complete(directories()),
    ),
    option(name("width"), schema(z.number().int().min(1).max(2560).default(1600))),
    option(name("quality"), schema(z.number().int().min(1).max(100).optional())),
    option(name("format"), schema(z.enum(["webp", "avif"]).default("webp")), complete(["webp", "avif"])),
    toggle(name("json"), description("One JSON result; application requires --yes")),
  ),
  {
    async run({ model }, context: AppContext) {
      try {
        const plan = await planReady(
          await inspectReady(model.paths, {
            cwd: context.cwd,
            env: context.env,
            signal: context.signal,
            changed: model.changed,
            width: model.width,
            format: model.format,
            review: model.review,
            ...(model.quality === undefined ? {} : { quality: model.quality }),
            ...(model.outDir === undefined ? {} : { outDir: model.outDir }),
          }),
        );
        for (const entry of plan.entries) {
          context.stderr.write(
            `${entry.status}: ${JSON.stringify(entry.path)}${entry.reason ? ` — ${entry.reason}` : ""}\n`,
          );
          for (const issue of entry.issues ?? [])
            context.stderr.write(`  ${issue.severity}: ${issue.code}: ${issue.message}\n`);
          for (const argv of entry.suggestions)
            context.stderr.write(`  Suggested argv: ${JSON.stringify(["sv", ...argv])}\n`);
        }
        for (const action of plan.actions)
          context.stderr.write(
            `Create ${action.kind}: ${JSON.stringify(action.destination)} (${action.bytes} bytes) from ${JSON.stringify(action.source)}\n`,
          );
        let status = plan.failures.length ? "blocked" : plan.actions.length ? "planned" : "noop";
        let receipt = null;
        let error: string | undefined;
        if (!plan.failures.length && !model.dryRun && (model.apply || model.yes) && plan.actions.length) {
          if (model.json && !model.yes) {
            status = "declined";
            error = "JSON application requires --yes";
          } else if (model.yes || (await context.confirm("Apply these outputs and record undo history?"))) {
            receipt = await applyReady(plan);
            status = receipt?.status ?? "noop";
          } else status = "declined";
        }
        const result = {
          command: "ready",
          schemaVersion: 1,
          status,
          entries: plan.entries,
          actions: plan.actions,
          failures: plan.failures,
          ...(error ? { error } : {}),
          ...(receipt ? { recordId: receipt.id, receipt } : {}),
        };
        context.stdout.write(
          model.json
            ? json(result)
            : `${status}: ${plan.actions.length} planned outputs${receipt ? `; recordId ${receipt.id}` : ""}${status === "noop" ? (plan.entries.length ? "; no applicable image outputs" : "; clean/no selected changes") : ""}\n`,
        );
        return ["blocked", "declined", "partial"].includes(status) ? 1 : 0;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (model.json)
          context.stdout.write(
            json({ command: "ready", schemaVersion: 1, status: "blocked", error: message }),
          );
        context.stderr.write(`${message}\n`);
        return 1;
      }
    },
  },
);
