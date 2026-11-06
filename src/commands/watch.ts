import { resolve } from "node:path";

import { argument, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { complete, defineCommand, files } from "../kit/index.ts";
import { displayPath } from "../lib/fs.ts";
import { plural, shellCommand } from "../lib/output.ts";
import { watchReady } from "../lib/watch.ts";

export const watch = defineCommand(
  command(
    name("watch"),
    description("Watch local content for read-only ready checks; never applies changes"),
    argument(
      name("paths"),
      description("Files or directories (default current directory)"),
      multiple(),
      schema(z.array(z.string()).default([])),
      complete(files()),
    ),
    toggle(name("changed"), description("Select staged, unstaged and untracked Git files")),
    option(
      name("interval"),
      description("Metadata polling interval in milliseconds (100-60000; default 1000)"),
      schema(z.number().int().min(100).max(60000).default(1000)),
    ),
    toggle(name("once"), description("Check once and exit; validation errors exit 1")),
    toggle(name("json"), description("Emit one versioned JSON event per check (NDJSON)")),
  ),
  {
    async run({ model }, context: AppContext) {
      let failed = false;
      if (!model.once)
        context.stderr.write(
          `Watching ${model.paths.length ? model.paths.map((path) => JSON.stringify(path)).join(", ") : "."}; read-only previews every ${model.interval}ms when inputs change. Stop with Ctrl+C.\n`,
        );
      try {
        for await (const event of watchReady(model.paths, {
          cwd: context.cwd,
          env: context.env,
          signal: context.signal,
          changed: model.changed,
          intervalMs: model.interval,
          once: model.once,
        })) {
          failed = event.status === "blocked";
          if (model.json) context.stdout.write(`${JSON.stringify(event)}\n`);
          else {
            context.stdout.write(
              `${event.reason === "initial" ? "Initial check" : "Changed inputs"}: ${event.status} · ${event.summary.files} ${plural(event.summary.files, "file")} · ${event.summary.outputs} planned ${plural(event.summary.outputs, "output")} · ${event.checks.errors} ${plural(event.checks.errors, "error")} · ${event.checks.warnings} ${plural(event.checks.warnings, "warning")}\n`,
            );
            for (const failure of event.failures) context.stdout.write(`  ${failure}\n`);
            for (const issue of event.issues.filter((issue) => issue.severity !== "error"))
              context.stdout.write(
                `  ${issue.severity}: ${displayPath(context.cwd, issue.file)}:${issue.line ?? 1} ${issue.code}: ${issue.message}\n`,
              );
            const command = [
              context.program,
              ...(resolve(context.cwd) === process.cwd() ? [] : ["--cwd", context.cwd]),
              "ready",
              ...(model.paths.length ? model.paths : ["."]),
              ...(model.changed ? ["--changed"] : []),
              "--apply",
            ];
            context.stdout.write(`No files written. Review and apply separately: ${shellCommand(command)}\n`);
          }
        }
      } catch (error) {
        if (context.signal.aborted && !model.once) return 0;
        throw error;
      }
      return model.once && (failed || context.signal.aborted) ? 1 : 0;
    },
  },
);
