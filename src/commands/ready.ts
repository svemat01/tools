import { resolve } from "node:path";

import { argument, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { complete, defineCommand, directories, files } from "../kit/index.ts";
import { displayPath } from "../lib/fs.ts";
import { formatBytes, json, plural, shellCommand } from "../lib/output.ts";
import { applyReady, inspectReady, planReady } from "../lib/ready.ts";

export const ready = defineCommand(
  command(
    name("ready"),
    description("Preview local content preparation; apply new image outputs with undo history"),
    argument(
      name("paths"),
      multiple(),
      description("Files or directories to prepare (default: current directory)"),
      schema(z.array(z.string()).default([])),
      complete(files()),
    ),
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
    option(
      name("width"),
      description("Maximum image width in pixels; never upscales (default: 1600)"),
      schema(z.number().int().min(1).max(2560).default(1600)),
    ),
    option(
      name("quality"),
      description("Encoding quality 1-100; explicit quality reencodes matching formats"),
      schema(z.number().int().min(1).max(100).optional()),
    ),
    option(
      name("format"),
      description("New image output format (default: webp)"),
      schema(z.enum(["webp", "avif"]).default("webp")),
      complete(["webp", "avif"]),
    ),
    toggle(name("json"), description("One JSON result; application requires --yes")),
  ),
  {
    async run({ model }, context: AppContext) {
      try {
        const program = ["sv", ...(resolve(context.cwd) === process.cwd() ? [] : ["--cwd", context.cwd])];
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
        const files = plan.entries.filter(
          (entry) => !["directory", "project", "blog", "generated", "deleted"].includes(entry.kind),
        ).length;
        const unsupported = plan.entries.filter((entry) => entry.status === "unsupported").length;
        const skipped = plan.entries.filter((entry) => entry.status === "skipped").length;
        context.stderr.write(
          `Ready preview: ${files} ${plural(files, "file")} · ${plan.actions.length} ${plural(plan.actions.length, "output")} · ${unsupported} unsupported · ${skipped} skipped\n`,
        );
        context.stderr.write(
          `Checks: ${plan.checks.errors} ${plural(plan.checks.errors, "error")} · ${plan.checks.warnings} ${plural(plan.checks.warnings, "warning")} · ${plan.checks.infos} info\n`,
        );
        const suggestions = new Set<string>();
        for (const entry of plan.entries) {
          const relative = displayPath(context.cwd, entry.path);
          if (entry.status !== "inspected")
            context.stderr.write(
              `  ${entry.status}: ${JSON.stringify(relative)}${entry.reason ? ` — ${entry.reason}` : ""}\n`,
            );
          for (const issue of entry.issues ?? [])
            context.stderr.write(
              `  ${issue.severity}: ${JSON.stringify(relative)}:${issue.line ?? 1} ${issue.code}: ${issue.message}\n`,
            );
          for (const argv of entry.suggestions)
            if (entry.status === "unsupported" || entry.status === "error" || (entry.issues?.length ?? 0) > 0)
              suggestions.add(
                shellCommand([...program, ...argv.map((word) => (word === entry.path ? relative : word))]),
              );
        }
        for (const action of plan.actions)
          context.stderr.write(
            `Create ${action.kind}: ${JSON.stringify(displayPath(context.cwd, action.destination))} (${formatBytes(action.bytes)}) from ${JSON.stringify(displayPath(context.cwd, action.source))}\n`,
          );
        for (const suggestion of [...suggestions].slice(0, 5)) context.stderr.write(`  Try: ${suggestion}\n`);
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
          checks: plan.checks,
          summary: {
            files,
            outputs: plan.actions.length,
            appliedOutputs: receipt?.files.filter((file) => file.status === "applied").length ?? 0,
            unsupported,
            skipped,
          },
          ...(error ? { error } : {}),
          ...(receipt ? { recordId: receipt.id, receipt } : {}),
        };
        context.stdout.write(
          model.json
            ? json(result)
            : `${status}: ${plan.actions.length} ${plural(plan.actions.length, "output")}${receipt ? `; recordId ${receipt.id}` : ""}${status === "noop" ? (plan.entries.length ? "; no applicable image outputs" : "; clean/no selected changes") : ""}\n`,
        );
        if (!model.json) {
          if (status === "blocked")
            context.stdout.write("No files written. Resolve the reported errors and run ready again.\n");
          else if (status === "planned") {
            const args = [...program, "ready", ...(model.paths.length ? model.paths : ["."])];
            if (model.changed) args.push("--changed");
            if (model.review) args.push("--review");
            if (model.outDir !== undefined) args.push("--out-dir", model.outDir);
            if (model.width !== 1600) args.push("--width", String(model.width));
            if (model.quality !== undefined) args.push("--quality", String(model.quality));
            if (model.format !== "webp") args.push("--format", model.format);
            args.push("--apply");
            context.stdout.write(
              `Preview only; originals are preserved. Apply with: ${shellCommand(args)}\n`,
            );
          } else if (status === "applied" && receipt)
            context.stdout.write(
              `Undo with: ${shellCommand([...program, "undo", receipt.id, "--dry-run"])}\n`,
            );
          else if (status === "declined")
            context.stdout.write("No files written. Use --yes to apply noninteractively.\n");
          else if (status === "partial" && receipt)
            context.stdout.write(
              `Applied ${receipt.files.filter((file) => file.status === "applied").length} of ${plan.actions.length} outputs before stopping: ${receipt.error ?? "operation interrupted"}\nInspect with: ${shellCommand([...program, "history", receipt.id])}\n`,
            );
        }
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
