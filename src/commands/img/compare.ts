import { basename, dirname, extname, join } from "node:path";

import { argument, cli, command, description, name, option, schema, toggle } from "@bomb.sh/router";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, files } from "../../kit/index.ts";
import { displayPath, nextAvailablePath, planOutputPath, writeFileAtomic } from "../../lib/fs.ts";
import { color, formatPercent, json, useColor } from "../../lib/output.ts";

interface RgbaImage {
  readonly data: Buffer;
  readonly width: number;
  readonly height: number;
}

async function loadRgba(path: string): Promise<RgbaImage> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

async function resizeRgba(path: string, width: number, height: number): Promise<RgbaImage> {
  const { data, info } = await sharp(path)
    .resize({ width, height, fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function sibling(path: string, suffix: string): string {
  const extension = extname(path);
  return join(dirname(path), `${basename(path, extension)}${suffix}${extension}`);
}

function metrics(
  before: RgbaImage,
  after: RgbaImage,
): { meanAbsoluteError: number; maxChannelDelta: number } {
  let sum = 0;
  let max = 0;
  for (let index = 0; index < before.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs((before.data[index + channel] ?? 0) - (after.data[index + channel] ?? 0));
      sum += delta;
      if (delta > max) max = delta;
    }
  }
  return {
    meanAbsoluteError: sum / (before.width * before.height * 3 || 1),
    maxChannelDelta: max,
  };
}

export const compare = defineCommand(
  command(
    name("compare"),
    description("Compare two images and write a visual diff"),
    argument(
      name("before"),
      description("Reference image"),
      schema(z.string()),
      complete(files({ extensions: ["png", "jpg", "jpeg", "webp", "avif", "gif", "tiff"] })),
    ),
    argument(
      name("after"),
      description("Image to compare against the reference"),
      schema(z.string()),
      complete(files({ extensions: ["png", "jpg", "jpeg", "webp", "avif", "gif", "tiff"] })),
    ),
    option(
      name("out"),
      cli(["--out", "-o"]),
      description("Diff image path (defaults to <after>-diff.png)"),
      schema(z.string().optional()),
      complete(files()),
    ),
    option(
      name("threshold"),
      description("Per-pixel colour tolerance (0-1); smaller is more sensitive"),
      schema(z.number().min(0).max(1).default(0.1)),
    ),
    option(
      name("maxDiff"),
      description("Allowed percentage of differing pixels before exit 1"),
      schema(z.number().min(0).max(100).default(0)),
    ),
    option(
      name("align"),
      description("What to do when dimensions differ"),
      schema(z.enum(["error", "before", "after", "smaller", "larger"]).default("error")),
      complete([
        { value: "error", description: "Fail with an explanation (default)" },
        { value: "before", description: "Stretch the after image to the reference size" },
        { value: "after", description: "Stretch the reference to the after image size" },
        { value: "smaller", description: "Stretch both to the smaller dimensions" },
        { value: "larger", description: "Stretch both to the larger dimensions" },
      ]),
    ),
    toggle(name("includeAa"), description("Count anti-aliased pixels as differences")),
    toggle(name("sideBySide"), description("Also write a side-by-side image")),
    toggle(name("overlay"), description("Also write a 50% overlay image")),
    toggle(name("force"), description("Overwrite existing output files")),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      const beforePath = model.before;
      const afterPath = model.after;
      let before = await loadRgba(beforePath);
      let after = await loadRgba(afterPath);
      let aligned = false;

      if (before.width !== after.width || before.height !== after.height) {
        if (model.align === "error") {
          throw new Error(
            `Image dimensions differ: ${before.width}×${before.height} vs ${after.width}×${after.height}. ` +
              "Use --align before|after|smaller|larger to compare explicitly.",
          );
        }
        const width =
          model.align === "before"
            ? before.width
            : model.align === "after"
              ? after.width
              : model.align === "smaller"
                ? Math.min(before.width, after.width)
                : Math.max(before.width, after.width);
        const height =
          model.align === "before"
            ? before.height
            : model.align === "after"
              ? after.height
              : model.align === "smaller"
                ? Math.min(before.height, after.height)
                : Math.max(before.height, after.height);
        before =
          before.width === width && before.height === height
            ? before
            : await resizeRgba(beforePath, width, height);
        after =
          after.width === width && after.height === height
            ? after
            : await resizeRgba(afterPath, width, height);
        aligned = true;
      }

      const width = before.width;
      const height = before.height;
      const diff = Buffer.alloc(width * height * 4);
      const diffPixels = pixelmatch(before.data, after.data, diff, width, height, {
        threshold: model.threshold,
        includeAA: model.includeAa,
        alpha: 0.35,
        diffColor: [255, 0, 0],
        diffColorAlt: [0, 128, 255],
        checkerboard: false,
      });
      const totalPixels = width * height;
      const percent = totalPixels === 0 ? 0 : (diffPixels / totalPixels) * 100;
      const errorMetrics = metrics(before, after);

      const diffPath = await planOutputPath({
        input: afterPath,
        cwd: context.cwd,
        extension: "png",
        suffix: "-diff",
        overwrite: model.force,
        ...(model.out === undefined ? {} : { out: model.out }),
      });
      await writeFileAtomic(
        diffPath,
        await sharp(diff, { raw: { width, height, channels: 4 } })
          .png()
          .toBuffer(),
      );

      const outputs: { readonly kind: string; readonly path: string }[] = [{ kind: "diff", path: diffPath }];

      if (model.sideBySide) {
        const gap = 16;
        const sidePath = model.force
          ? sibling(diffPath, "-side-by-side")
          : nextAvailablePath(sibling(diffPath, "-side-by-side"));
        const canvas = sharp({
          create: {
            width: width * 2 + gap,
            height,
            channels: 4,
            background: { r: 255, g: 255, b: 255, alpha: 1 },
          },
        });
        const beforePng = await sharp(before.data, { raw: { width, height, channels: 4 } })
          .png()
          .toBuffer();
        const afterPng = await sharp(after.data, { raw: { width, height, channels: 4 } })
          .png()
          .toBuffer();
        await writeFileAtomic(
          sidePath,
          await canvas
            .composite([
              { input: beforePng, left: 0, top: 0 },
              { input: afterPng, left: width + gap, top: 0 },
            ])
            .png()
            .toBuffer(),
        );
        outputs.push({ kind: "side-by-side", path: sidePath });
      }

      if (model.overlay) {
        const overlayPath = model.force
          ? sibling(diffPath, "-overlay")
          : nextAvailablePath(sibling(diffPath, "-overlay"));
        const overlayPixels = Buffer.from(after.data);
        for (let index = 3; index < overlayPixels.length; index += 4) {
          overlayPixels[index] = Math.round((overlayPixels[index] ?? 255) * 0.5);
        }
        const overlayPng = await sharp(overlayPixels, {
          raw: { width, height, channels: 4 },
        })
          .png()
          .toBuffer();
        await writeFileAtomic(
          overlayPath,
          await sharp(before.data, { raw: { width, height, channels: 4 } })
            .composite([{ input: overlayPng, blend: "over" }])
            .png()
            .toBuffer(),
        );
        outputs.push({ kind: "overlay", path: overlayPath });
      }

      const withinTolerance = percent <= model.maxDiff;
      if (model.json) {
        context.stdout.write(
          json({
            command: "img compare",
            before: displayPath(context.cwd, beforePath),
            after: displayPath(context.cwd, afterPath),
            width,
            height,
            aligned,
            diffPixels,
            totalPixels,
            percent,
            meanAbsoluteError: errorMetrics.meanAbsoluteError,
            maxChannelDelta: errorMetrics.maxChannelDelta,
            threshold: model.threshold,
            maxDiff: model.maxDiff,
            withinTolerance,
            outputs: outputs.map((output) => ({
              kind: output.kind,
              path: displayPath(context.cwd, output.path),
            })),
          }),
        );
      } else {
        const useColour = useColor(context.stdout, context.env);
        context.stdout.write(
          `${displayPath(context.cwd, beforePath)} vs ${displayPath(context.cwd, afterPath)}\n` +
            `  ${width}×${height}${aligned ? " (aligned)" : ""}\n` +
            `  ${diffPixels} / ${totalPixels} pixels differ (${formatPercent(percent)})\n` +
            `  mean channel error ${errorMetrics.meanAbsoluteError.toFixed(2)}, max ${errorMetrics.maxChannelDelta}\n` +
            `  ${withinTolerance ? color("within tolerance", "green", useColour) : color("outside tolerance", "red", useColour)}\n`,
        );
        for (const output of outputs) {
          context.stdout.write(`  ${output.kind}: ${displayPath(context.cwd, output.path)}\n`);
        }
      }

      return withinTolerance ? 0 : 1;
    },
  },
);
