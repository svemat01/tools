import { argument, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import {
  applyBlogPrepare,
  loadBlogConfig,
  planBlogPrepare,
  resolveBlogProject,
  type PreparePlan,
} from "../../lib/blog.ts";
import { displayPath } from "../../lib/fs.ts";
import { color, formatBytes, formatSavings, json, plural, useColor } from "../../lib/output.ts";
import { confirm } from "../../lib/prompt.ts";
import { complete, defineCommand, directories } from "../../kit/index.ts";

interface Failure {
  readonly entry: string;
  readonly error: string;
}

export const prepare = defineCommand(
  command(
    name("prepare"),
    description("Preview and apply safe blog fixes: Notion artifacts, tracking parameters, images and Unicode"),
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
    toggle(name("dryRun"), description("Preview every change without writing anything")),
    toggle(name("yes"), description("Apply without an interactive confirmation (required when not a TTY)")),
    toggle(name("noImages"), description("Do not optimize or rewrite referenced images")),
    toggle(name("noUnicode"), description("Do not replace invisible or typographic characters")),
    toggle(
      name("deleteOriginals"),
      description("Delete replaced image originals after a successful write (explicit opt-in)"),
    ),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      const loaded = await loadBlogConfig(context.cwd, model.config);
      const config = model.deleteOriginals
        ? { ...loaded.config, prepare: { ...loaded.config.prepare, deleteOriginals: true } }
        : loaded.config;
      const targets = model.paths.length > 0 ? model.paths : ["."];

      const plans: PreparePlan[] = [];
      const failures: Failure[] = [];

      for (const target of targets) {
        const project = await resolveBlogProject(target, context.cwd, config);
        if (project.posts.length === 0) {
          context.stderr.write(`No blog posts found under ${target}. Check --config and the postsDir setting.\n`);
          return 1;
        }
        for (const post of project.posts) {
          try {
            plans.push(
              await planBlogPrepare(post, config, {
                cwd: context.cwd,
                noImages: model.noImages,
                noUnicode: model.noUnicode,
              }),
            );
          } catch (error) {
            failures.push({
              entry: post.entry,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      for (const failure of failures) {
        context.stderr.write(`${displayPath(context.cwd, failure.entry)}: ${failure.error}\n`);
      }

      const changed = plans.filter((plan) => plan.changed);
      const editCount = changed.reduce((count, plan) => count + plan.edits.length, 0);
      const images = changed.flatMap((plan) => plan.images);
      const before = images.reduce((total, image) => total + image.before, 0);
      const after = images.reduce((total, image) => total + image.after, 0);

      if (failures.length > 0) {
        context.stderr.write("Aborted before writing because some posts could not be prepared.\n");
        return 1;
      }

      if (changed.length === 0) {
        if (model.json) {
          context.stdout.write(
            json({
              command: "blog prepare",
              dryRun: model.dryRun === true,
              applied: false,
              posts: plans.map(serialisePlan),
              failures,
            }),
          );
        } else {
          context.stdout.write("Nothing to prepare.\n");
        }
        return 0;
      }

      const canApply =
        model.dryRun === true ||
        model.yes === true ||
        (await confirm(`Apply changes to ${changed.length} ${plural(changed.length, "post")}?`));

      if (!model.dryRun && !canApply) {
        context.stderr.write(
          model.yes
            ? "cancelled; no files were modified\n"
            : "refusing to modify files without --yes in a non-interactive terminal\n",
        );
        return 1;
      }

      const applied =
        model.dryRun === true
          ? []
          : await Promise.all(changed.map((plan) => applyBlogPrepare(plan, config)));

      if (model.json) {
        context.stdout.write(
          json({
            command: "blog prepare",
            dryRun: model.dryRun === true,
            applied: model.dryRun !== true,
            posts: changed.map(serialisePlan),
            writtenImages: applied.flatMap((result) =>
              result.writtenImages.map((path) => displayPath(context.cwd, path)),
            ),
            deletedOriginals: applied.flatMap((result) =>
              result.deletedOriginals.map((path) => displayPath(context.cwd, path)),
            ),
            failures,
            totals: { images: images.length, before, after },
          }),
        );
        return 0;
      }

      const useColour = useColor(context.stdout, context.env);
      const title = loaded.config.name ? `Blog prepare: ${loaded.config.name}` : "Blog prepare";
      context.stdout.write(`${color(title, "bold", useColour)}\n`);
      for (const plan of changed) {
        context.stdout.write(`\n${color(displayPath(context.cwd, plan.entry), "bold", useColour)}\n`);
        for (const edit of plan.edits) {
          const line = edit.line === undefined ? "" : `line ${edit.line}  `;
          context.stdout.write(`  ${line}${edit.reason}\n`);
          if (edit.before !== undefined && edit.after !== undefined) {
            context.stdout.write(`      ${edit.before} → ${edit.after}\n`);
          }
        }
      }

      if (images.length > 0) {
        context.stdout.write(`\n${color("Media", "bold", useColour)}\n`);
        for (const image of images) {
          context.stdout.write(
            `  ${displayPath(context.cwd, image.input)} → ${displayPath(context.cwd, image.output)}  ` +
              `${formatBytes(image.before)} → ${formatBytes(image.after)} (${formatSavings(
                image.before,
                image.after,
              )})\n`,
          );
        }
      }

      context.stdout.write(
        `\n${color("Plan", "bold", useColour)}  ${changed.length} ${plural(changed.length, "post")} · ` +
          `${editCount} ${plural(editCount, "edit")} · ${images.length} ${plural(images.length, "image")}` +
          `${images.length > 0 ? ` · ${formatBytes(before)} → ${formatBytes(after)}` : ""}\n`,
      );

      if (model.dryRun) {
        context.stdout.write("Dry run: no files were written.\n");
        return 0;
      }

      context.stdout.write(
        `\nUpdated ${changed.length} ${plural(changed.length, "post")} and wrote ${images.length} ${plural(
          images.length,
          "image",
        )}.\n`,
      );
      const deleted = applied.flatMap((result) => result.deletedOriginals);
      if (deleted.length > 0) {
        context.stdout.write(`Deleted ${deleted.length} replaced ${plural(deleted.length, "original")}.\n`);
      }
      return 0;
    },
  },
);

function serialisePlan(plan: PreparePlan): Record<string, unknown> {
  return {
    entry: plan.entry,
    changed: plan.changed,
    unicodeReplacements: plan.unicodeReplacements,
    collapsedBlankLines: plan.collapsedBlankLines,
    edits: plan.edits.map((edit) => ({
      reason: edit.reason,
      line: edit.line,
      before: edit.before,
      after: edit.after,
    })),
    images: plan.images.map((image) => ({
      input: image.input,
      output: image.output,
      action: image.action,
      before: image.before,
      after: image.after,
      width: image.width,
      height: image.height,
      format: image.format,
      nextUrl: image.nextUrl,
    })),
  };
}
