import { argument, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../context.ts";
import { displayPath } from "../lib/fs.ts";
import { color, formatBytes, json, plural, useColor } from "../lib/output.ts";
import { confirm } from "../lib/prompt.ts";
import { fixScans, isFixable, scanPaths, unicodeName, type Severity } from "../lib/unicode.ts";
import { complete, defineCommand, files } from "../kit/index.ts";

const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warn: 1, error: 2 };

export const gremlins = defineCommand(
  command(
    name("gremlins"),
    description("Find suspicious or invisible Unicode characters in files and directories"),
    argument(
      name("paths"),
      multiple(),
      description("Files or directories to scan (default: .)"),
      schema(z.array(z.string()).default([])),
      complete(files()),
    ),
    toggle(name("fix"), description("Apply safe fixes after previewing the changes")),
    toggle(name("fixTypography"), description("Also replace curly quotes and en dashes with --fix")),
    toggle(name("dryRun"), description("Preview fixes without writing")),
    toggle(name("yes"), description("Apply fixes without an interactive confirmation")),
    toggle(name("includeHidden"), description("Include dot-directories when walking")),
    toggle(name("noGitignore"), description("Do not use git ls-files for directory scans")),
    option(
      name("minSeverity"),
      description("Only display findings at or above this severity"),
      schema(z.enum(["info", "warn", "error"]).default("info")),
      complete(["info", "warn", "error"]),
    ),
    option(
      name("maxBytes"),
      description("Skip files larger than this many bytes"),
      schema(z.number().int().positive().default(5 * 1024 * 1024)),
    ),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      const targets = model.paths.length > 0 ? model.paths : ["."];
      const summary = await scanPaths(targets, {
        cwd: context.cwd,
        maxBytes: model.maxBytes,
        typography: model.fixTypography,
        includeHidden: model.includeHidden,
        respectGitIgnore: !model.noGitignore,
        signal: context.signal,
      });

      const min = SEVERITY_ORDER[model.minSeverity];
      const visible = summary.files
        .map((file) => ({
          file,
          findings: file.findings.filter((finding) => SEVERITY_ORDER[finding.rule.severity] >= min),
        }))
        .filter((entry) => entry.findings.length > 0);

      let fixSummary: Awaited<ReturnType<typeof fixScans>> | undefined;
      let applyError: string | undefined;
      if (model.fix) {
        const fixable = summary.files.reduce(
          (count, file) =>
            count + file.findings.filter((finding) => isFixable(finding.rule, model.fixTypography)).length,
          0,
        );
        if (fixable > 0 && !model.dryRun) {
          const allowed = model.yes || (await confirm(`Apply ${fixable} replacements?`));
          if (allowed) {
            fixSummary = await fixScans(summary.files, {
              typography: model.fixTypography,
              dryRun: false,
            });
          } else {
            applyError =
              model.yes || process.stdin.isTTY
                ? "cancelled; no files were modified"
                : "refusing to modify files without --yes in a non-interactive terminal";
          }
        } else if (fixable > 0 && model.dryRun) {
          fixSummary = await fixScans(summary.files, {
            typography: model.fixTypography,
            dryRun: true,
          });
        }
      }

      const remaining = summary.totalFindings - (fixSummary?.replacements ?? 0);
      if (model.json) {
        context.stdout.write(
          json({
            command: "gremlins",
            scanned: summary.scanned,
            skipped: summary.skipped.map((entry) => ({
              path: displayPath(context.cwd, entry.path),
              reason: entry.reason,
            })),
            totalFindings: summary.totalFindings,
            fixableFindings: summary.fixableFindings,
            findings: visible.flatMap(({ file, findings }) =>
              findings.map((finding) => ({
                file: displayPath(context.cwd, file.path),
                line: finding.line,
                column: finding.column,
                codePoint: unicodeName(finding.codePoint),
                severity: finding.rule.severity,
                category: finding.rule.category,
                description: finding.rule.description,
                fixable: isFixable(finding.rule, model.fixTypography),
                preview: finding.preview,
              })),
            ),
            fix: fixSummary
              ? {
                  dryRun: model.dryRun,
                  replacements: fixSummary.replacements,
                  changed: fixSummary.changed.map((entry) => ({
                    path: displayPath(context.cwd, entry.path),
                    changes: entry.changes,
                    before: entry.before,
                    after: entry.after,
                  })),
                  skipped: fixSummary.skipped.map((entry) => ({
                    path: displayPath(context.cwd, entry.path),
                    reason: entry.reason,
                  })),
                }
              : undefined,
            error: applyError,
            remaining,
            aborted: context.signal.aborted,
          }),
        );
      } else {
        const useColour = useColor(context.stdout, context.env);
        context.stdout.write(
          `${color("Gremlins scan", "bold", useColour)}  ${targets.map((target) => target).join(", ")}\n`,
        );
        for (const { file, findings } of visible) {
          context.stdout.write(`\n${color(displayPath(context.cwd, file.path), "bold", useColour)}\n`);
          for (const finding of findings) {
            const levelColor =
              finding.rule.severity === "error" ? "red" : finding.rule.severity === "warn" ? "yellow" : "cyan";
            const label = color(finding.rule.severity.toUpperCase().padEnd(5), levelColor, useColour);
            const action = isFixable(finding.rule, model.fixTypography)
              ? finding.rule.replacement === ""
                ? " → remove"
                : ` → ${JSON.stringify(finding.rule.replacement)}`
              : "";
            context.stdout.write(
              `  ${label} ${`${finding.line}:${finding.column}`.padEnd(10)} ` +
                `${unicodeName(finding.codePoint)} ${finding.rule.description}${action}\n`,
            );
            context.stdout.write(`        ${finding.preview}\n`);
          }
        }

        if (summary.totalFindings === 0) {
          context.stdout.write(`${color("No gremlins found.", "green", useColour)}\n`);
        } else {
          context.stdout.write(
            `\n${color("Summary", "bold", useColour)}  ${summary.totalFindings} ${plural(
              summary.totalFindings,
              "finding",
            )} · ${visible.length} ${plural(visible.length, "file")} · ${summary.fixableFindings} auto-fixable\n`,
          );
        }
        if (summary.skipped.length > 0) {
          context.stdout.write(
            `${color(`${summary.scanned} scanned · ${summary.skipped.length} skipped`, "gray", useColour)}\n`,
          );
        }

        if (fixSummary) {
          if (fixSummary.changed.length > 0) {
            context.stdout.write(`\n${color(model.dryRun ? "Planned fixes" : "Updated files", "bold", useColour)}\n`);
            for (const entry of fixSummary.changed) {
              context.stdout.write(
                `  ${displayPath(context.cwd, entry.path)}  ${entry.changes} replacement(s)  ` +
                  `${formatBytes(entry.before)} → ${formatBytes(entry.after)}\n`,
              );
            }
            context.stdout.write(
              `${model.dryRun ? "Would replace" : "Replaced"} ${fixSummary.replacements} ${plural(
                fixSummary.replacements,
                "character",
              )} in ${fixSummary.changed.length} ${plural(fixSummary.changed.length, "file")}.\n`,
            );
          } else if (summary.fixableFindings > 0) {
            context.stdout.write("No automatic fixes could be applied.\n");
          }
        }
        if (applyError) context.stderr.write(`${applyError}\n`);
        if (!model.fix && summary.fixableFindings > 0) {
          context.stdout.write(`\nRun ${color("sv gremlins <path> --fix", "cyan", useColour)} to apply safe fixes.\n`);
        }
        if (remaining > 0 && model.fix) {
          context.stdout.write(`${remaining} finding(s) remain for manual review.\n`);
        }
      }

      return remaining > 0 || applyError !== undefined || context.signal.aborted ? 1 : 0;
    },
  },
);
