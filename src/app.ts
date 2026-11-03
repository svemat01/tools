/**
 * The `sv` application: the composition root.
 *
 * To add a command: write a module exporting `defineCommand(command(...), {...})`
 * and list it inside the group it belongs to (or here, at the top level).
 */
import { command, description, name, printHelp, version } from "@bomb.sh/router";

import pkg from "../package.json" with { type: "json" };
import { dev } from "./commands/dev/index.ts";
import { media } from "./commands/media/index.ts";
import { createContext } from "./context.ts";
import { createApp, defineCommand } from "./kit/index.ts";
import { globalOptions } from "./options.ts";

export const sv = defineCommand(
  command(
    name("sv"),
    description("Personal development toolkit"),
    version(pkg.version),
    globalOptions,
    media,
    dev,
  ),
  {
    // Bare `sv`: an overview for now; a natural home for an interactive menu later.
    run(intent, context) {
      context.stdout.write(`${printHelp({ ...intent, method: "help" })}\n`);
    },
  },
);

export const app = createApp(sv, { context: createContext });
