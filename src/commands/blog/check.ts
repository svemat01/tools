import { argument, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import {
  checkBlog,
  loadBlogConfig,
  resolveBlogProject,
  type BlogIssue,
} from "../../lib/blog.ts";
import { displayPath } from "../../lib/fs.ts";
import { color, json, plural, useColor, type ColorName } from "../../lib/output.ts";
import { complete, defineCommand, directories } from "../../kit/index.ts";

const SEVERITY_COLOUR: Record<BlogIssue["severity"], ColorName> = {
  error: "red",
  warn: "yellow",
  info: "cyan",
};

const SEVERITY_LABEL: Record<BlogIssue["severity"], string> = {
  error: "ERROR",
  warn: "WARN",
  info: "INFO",
};

export const check = defineCommand(
  command(
    name("check"),
    description("Validate blog posts: metadata, media, links, alt text, Unicode and slugs"),
    argument(
      name("paths"),
      multiple(),
      description("Posts, post directories or a project root (default: .)"),
      schema(z.array(z.string()).default([])),
      complete(directories()),
    ),
    option(
      name("config"),
      description("Blog config file (default: sv.blog.json, .sv/blog.json, blog.config.json)"),
      schema(z.string().optional()),
      complete([{ value: "sv.blog.json", description: "Default config file" }]),
    ),
    toggle(name("strict"), description("Treat warnings as failures")),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      const loaded = await loadBlogConfig(context.cwd, model.config);
      const targets = model.paths.length > 0 ? model.paths : ["."];
      const issues: BlogIssue[] = [];
      const projects = [];
      let posts = 0;
      let errors = 0;
      let warnings = 0;
      let infos = 0;
      let ok = true;

      for (const target of targets) {
        const project = await resolveBlogProject(target, context.cwd, loaded.config);
        const summary = await checkBlog(project, loaded.config, {
          cwd: context.cwd,
          strict: model.strict,
        });
        projects.push({
          kind: project.kind,
          root: displayPath(context.cwd, project.projectRoot),
          posts: summary.posts,
        });
        issues.push(...summary.issues);
        posts += summary.posts;
        errors += summary.errors;
        warnings += summary.warnings;
        infos += summary.infos;
        ok &&= summary.ok;
      }

      if (posts === 0) {
        context.stderr.write("No blog posts found. Check --config, the target path and the postsDir setting.\n");
        return 1;
      }

      const sorted = [...issues].sort(
        (a, b) =>
          a.file.localeCompare(b.file) ||
          (a.line ?? 0) - (b.line ?? 0) ||
          (a.column ?? 0) - (b.column ?? 0),
      );

      if (model.json) {
        context.stdout.write(
          json({
            command: "blog check",
            config: loaded.source === undefined ? undefined : displayPath(context.cwd, loaded.source),
            projects,
            posts,
            errors,
            warnings,
            infos,
            strict: model.strict === true,
            ok,
            issues: sorted.map((issue) => ({
              severity: issue.severity,
              code: issue.code,
              message: issue.message,
              file: displayPath(context.cwd, issue.file),
              line: issue.line,
              column: issue.column,
            })),
          }),
        );
      } else {
        const useColour = useColor(context.stdout, context.env);
        const title = loaded.config.name ? `Blog check: ${loaded.config.name}` : "Blog check";
        context.stdout.write(`${color(title, "bold", useColour)}  ${posts} ${plural(posts, "post")}\n`);

        let currentFile: string | undefined;
        for (const issue of sorted) {
          const file = displayPath(context.cwd, issue.file);
          if (file !== currentFile) {
            currentFile = file;
            context.stdout.write(`\n${color(file, "bold", useColour)}\n`);
          }
          const location = `${issue.line ?? 1}:${issue.column ?? 1}`.padEnd(9);
          const severity = color(SEVERITY_LABEL[issue.severity].padEnd(5), SEVERITY_COLOUR[issue.severity], useColour);
          context.stdout.write(`  ${severity} ${location} ${issue.code}  ${issue.message}\n`);
        }

        context.stdout.write(
          `\n${color("Summary", "bold", useColour)}  ${posts} ${plural(posts, "post")} · ` +
            `${errors} ${plural(errors, "error")} · ${warnings} ${plural(warnings, "warning")} · ` +
            `${infos} info${model.strict ? " · strict" : ""}\n`,
        );
        context.stdout.write(
          ok
            ? `${color("All checks passed.", "green", useColour)}\n`
            : `${color("Checks failed.", "red", useColour)}\n`,
        );
      }

      return ok ? 0 : 1;
    },
  },
);
