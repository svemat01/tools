import { resolve } from "node:path";

import { argument, command, description, multiple, name, schema } from "@bomb.sh/router";
import { z } from "zod";

import type { AppContext } from "../../context.ts";
import { complete, defineCommand, files } from "../../kit/index.ts";

export const inspect = defineCommand(
  command(
    name("inspect"),
    description("Print the size of one or more files"),
    argument(
      name("files"),
      multiple(),
      description("Files to inspect"),
      schema(z.array(z.string()).min(1)),
      complete(files()),
    ),
  ),
  {
    async run({ model }, context: AppContext) {
      let missing = 0;
      for (const path of model.files) {
        const file = Bun.file(resolve(context.cwd, path));
        if (await file.exists()) {
          context.stdout.write(`${path}\t${file.size} bytes\n`);
        } else {
          context.log.info(`${path}: not found`);
          missing++;
        }
      }
      return missing > 0 ? 1 : 0;
    },
  },
);
