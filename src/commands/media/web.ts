import { argument, cli, command, description, name, option, schema } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, files } from "../../kit/index.ts";
import { mediaOptions } from "./options.ts";

/** Illustrative stub: prints the conversion it would perform. */
export const web = defineCommand(
  command(
    name("web"),
    description("Convert an image for the web (stub: prints the plan)"),
    argument(
      name("input"),
      description("Image to convert"),
      schema(z.string()),
      complete(files({ extensions: ["png", "jpg", "jpeg", "gif", "webp", "avif"] })),
    ),
    option(
      name("format"),
      description("Output format"),
      schema(z.enum(["webp", "avif"]).default("webp")),
      complete([
        { value: "webp", description: "Broad support" },
        { value: "avif", description: "Smaller, slower to encode" },
      ]),
    ),
    // Same name as the group option: Router keeps both, scoped to their routes.
    option(
      name("quality"),
      description("Override the group's --quality for this command"),
      schema(z.number().int().min(1).max(100).optional()),
    ),
    option(
      name("out"),
      cli(["--out", "-o"]),
      description("Output file"),
      schema(z.string().optional()),
      complete(files()),
    ),
  ),
  {
    inherit: { media: mediaOptions },
    run({ model }, context: AppContext, { media }) {
      const quality = model.quality ?? media.quality;
      const out = model.out ?? `${model.input.replace(/\.[^./]+$/, "")}.${model.format}`;
      context.log.debug(
        `quality ${quality} from ${model.quality === undefined ? "sv media --quality" : "--quality"}`,
      );
      context.stdout.write(`would convert ${model.input} -> ${out} (${model.format}, quality ${quality})\n`);
    },
  },
);
