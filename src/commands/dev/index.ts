import { command, description, name, toggle } from "@bomb.sh/router";

import { defineCommand } from "../../kit/index.ts";
import { echo } from "./echo.ts";

/** An executable group: `sv dev` runs this handler, `sv dev echo` runs the child. */
export const dev = defineCommand(
  command(
    name("dev"),
    description("Development utilities"),
    toggle(name("json"), description("Print as JSON")),
    echo,
  ),
  {
    run({ model }, context) {
      const info = {
        program: context.program,
        bun: Bun.version,
        platform: process.platform,
        cwd: context.cwd,
      };
      const text = model.json
        ? JSON.stringify(info)
        : Object.entries(info)
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n");
      context.stdout.write(`${text}\n`);
    },
  },
);
