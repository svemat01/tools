import { argument, cli, command, description, multiple, name, option, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, directories } from "../../kit/index.ts";
import {
  applyBlogPreparePlans,
  createPrepareSession,
  loadBlogConfig,
  planBlogPrepare,
  PrepareApplyError,
  type PreparePlan,
  resolveBlogProject,
} from "../../lib/blog.ts";
import { displayPath } from "../../lib/fs.ts";
import { color, formatBytes, formatSavings, json, plural, useColor } from "../../lib/output.ts";

interface Failure {
  readonly entry: string;
  readonly error: string;
}

export const prepare = defineCommand(
  command(
    name("prepare"),
    description(
      "Preview and apply safe blog fixes: Notion artifacts, tracking parameters, images and Unicode",
    ),
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
    toggle(
      name("yes"),
      description("Apply without an interactive confirmation (required when not a TTY)"),
      cli(["--yes"], { switch: true }),
    ),
    toggle(
      name("noImages"),
      description("Do not optimize or rewrite referenced images"),
      cli(["--no-images"], { switch: true }),
    ),
    toggle(
      name("noUnicode"),
      description("Do not replace invisible or typographic characters"),
      cli(["--no-unicode"], { switch: true }),
    ),
    toggle(
      name("deleteOriginals"),
      description("Delete replaced image originals after a successful write (explicit opt-in)"),
      cli(["--delete-originals"], { switch: true }),
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
      const session = createPrepareSession();
      const plannedEntries = new Set<string>();

      for (const target of targets) {
        context.signal.throwIfAborted();
        let project;
        try {
          project = await resolveBlogProject(target, context.cwd, config);
        } catch (error) {
          failures.push({ entry: target, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        if (project.posts.length === 0) {
          failures.push({ entry: target, error: "No blog posts found; check --config and postsDir" });
          continue;
        }
        for (const post of project.posts) {
          context.signal.throwIfAborted();
          if (plannedEntries.has(post.entry)) continue;
          plannedEntries.add(post.entry);
          try {
            plans.push(
              await planBlogPrepare(post, config, {
                cwd: context.cwd,
                noImages: model.noImages,
                noUnicode: model.noUnicode,
                session,
                signal: context.signal,
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
      const images = [
        ...new Map(changed.flatMap((plan) => plan.images).map((image) => [image.output, image])).values(),
      ];
      const before = images.reduce((total, image) => total + image.before, 0);
      const after = images.reduce((total, image) => total + image.after, 0);

      if (failures.length > 0) {
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
        }
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

      if (!model.json) {
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
      }

      const canApply =
        model.dryRun === true ||
        model.yes === true ||
        (!model.json &&
          (await context.confirm(`Apply changes to ${changed.length} ${plural(changed.length, "post")}?`)));
      const applied: Awaited<ReturnType<typeof applyBlogPreparePlans>> = [];
      let applyError: string | undefined;
      let completedEntries: readonly string[] = [];
      let publishedImages: readonly string[] = [];
      let removedOriginals: readonly string[] = [];
      if (!canApply) {
        applyError = "cancelled or non-interactive input; use --yes to apply changes";
      } else if (!model.dryRun) {
        try {
          applied.push(...(await applyBlogPreparePlans(changed, config, { signal: context.signal })));
          completedEntries = applied.map((result) => result.plan.entry);
          publishedImages = [...new Set(applied.flatMap((result) => result.writtenImages))];
          removedOriginals = [...new Set(applied.flatMap((result) => result.deletedOriginals))];
        } catch (error) {
          applyError = error instanceof Error ? error.message : String(error);
          if (error instanceof PrepareApplyError) {
            completedEntries = error.completedEntries;
            publishedImages = error.writtenImages;
            removedOriginals = error.deletedOriginals;
          }
        }
      }

      if (model.json) {
        context.stdout.write(
          json({
            command: "blog prepare",
            dryRun: model.dryRun === true,
            applied: !model.dryRun && applyError === undefined,
            posts: changed.map(serialisePlan),
            completedEntries: completedEntries.map((path) => displayPath(context.cwd, path)),
            writtenImages: publishedImages.map((path) => displayPath(context.cwd, path)),
            deletedOriginals: removedOriginals.map((path) => displayPath(context.cwd, path)),
            retainedOriginals: applied.flatMap((result) => result.retainedOriginals),
            failures,
            error: applyError,
            totals: { images: images.length, before, after },
          }),
        );
        return applyError === undefined ? 0 : 1;
      }
      if (applyError !== undefined) {
        context.stderr.write(`${applyError}\n`);
        return 1;
      }
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
      const deleted = [...new Set(applied.flatMap((result) => result.deletedOriginals))];
      for (const retained of new Map(
        applied.flatMap((result) => result.retainedOriginals).map((entry) => [entry.path, entry]),
      ).values()) {
        context.stderr.write(`Preserved ${displayPath(context.cwd, retained.path)}: ${retained.reason}\n`);
      }
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
