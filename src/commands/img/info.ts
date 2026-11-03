import { argument, command, description, multiple, name, schema, toggle } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { displayPath, resolvePath } from "../../lib/fs.ts";
import { IMAGE_EXTENSIONS, formatDimensions, inspectImage, type ImageInfo } from "../../lib/image.ts";
import { color, formatBytes, json, useColor } from "../../lib/output.ts";
import { complete, defineCommand, files } from "../../kit/index.ts";

export const info = defineCommand(
  command(
    name("info"),
    description("Inspect image dimensions, format, size and animation metadata"),
    argument(
      name("files"),
      multiple(),
      description("Images to inspect"),
      schema(z.array(z.string()).min(1)),
      complete(files({ extensions: IMAGE_EXTENSIONS })),
    ),
    toggle(name("json"), description("Print machine-readable JSON")),
  ),
  {
    async run({ model }, context: AppContext) {
      const results: { readonly info: ImageInfo; readonly display: string }[] = [];
      const failures: { readonly path: string; readonly error: string }[] = [];

      for (const value of model.files) {
        if (context.signal.aborted) break;
        const path = resolvePath(context.cwd, value);
        try {
          const inspected = await inspectImage(path);
          results.push({ info: inspected, display: displayPath(context.cwd, path) });
        } catch (error) {
          failures.push({
            path: value,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (model.json) {
        context.stdout.write(
          json({
            command: "img info",
            files: results.map(({ info: value, display }) => ({
              path: display,
              bytes: value.bytes,
              format: value.format,
              width: value.width,
              height: value.height,
              space: value.space,
              channels: value.channels,
              hasAlpha: value.hasAlpha,
              density: value.density,
              orientation: value.orientation,
              pages: value.pages,
              pageHeight: value.pageHeight,
              animated: value.animated,
              loop: value.loop,
              delay: value.delay,
              hasProfile: value.hasProfile,
              hasExif: value.hasExif,
            })),
            failures,
          }),
        );
      } else {
        const useColour = useColor(context.stdout, context.env);
        for (const { info: value, display } of results) {
          context.stdout.write(`${color(display, "bold", useColour)}\n`);
          context.stdout.write(`  format:     ${value.format}\n`);
          context.stdout.write(`  dimensions: ${formatDimensions(value.width, value.height)}\n`);
          context.stdout.write(`  file size:  ${formatBytes(value.bytes)} (${value.bytes} bytes)\n`);
          if (value.space) context.stdout.write(`  colour:     ${value.space}${value.hasAlpha ? " + alpha" : ""}\n`);
          if (value.channels !== undefined) context.stdout.write(`  channels:   ${value.channels}\n`);
          if (value.density !== undefined) context.stdout.write(`  density:    ${value.density} dpi\n`);
          if (value.orientation !== undefined) context.stdout.write(`  orientation: ${value.orientation}\n`);
          if (value.animated) {
            context.stdout.write(
              `  animation:  ${value.pages} frames${value.loop === undefined ? "" : `, loop ${value.loop}`}\n`,
            );
          }
          if (value.hasProfile) context.stdout.write("  profile:    embedded colour profile\n");
          if (value.hasExif) context.stdout.write("  exif:       present\n");
          context.stdout.write("\n");
        }
        for (const failure of failures) {
          context.stderr.write(`${failure.path}: ${failure.error}\n`);
        }
      }

      return failures.length > 0 ? 1 : 0;
    },
  },
);
