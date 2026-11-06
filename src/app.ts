/**
 * The `sv` application: the composition root.
 *
 * To add a command: write a module exporting `defineCommand(command(...), {...})`
 * and list it inside the group it belongs to (or here, at the top level).
 */
import { command, description, name, printHelp, version } from "@bomb.sh/router";

import pkg from "../package.json" with { type: "json" };
import { blog } from "./commands/blog/index.ts";
import { dev } from "./commands/dev/index.ts";
import { doctor } from "./commands/doctor.ts";
import { gremlins } from "./commands/gremlins.ts";
import { history } from "./commands/history.ts";
import { img } from "./commands/img/index.ts";
import { init } from "./commands/init.ts";
import { inspect } from "./commands/inspect.ts";
import { jwt } from "./commands/jwt/index.ts";
import { paste } from "./commands/paste.ts";
import { ready } from "./commands/ready.ts";
import { share } from "./commands/share.ts";
import { tunnel } from "./commands/tunnel.ts";
import { undo } from "./commands/undo.ts";
import { video } from "./commands/video/index.ts";
import { watch } from "./commands/watch.ts";
import { createContext } from "./context.ts";
import { createApp, defineCommand } from "./kit/index.ts";
import { globalOptions } from "./options.ts";

export const sv = defineCommand(
  command(
    name("sv"),
    description("Inspect, prepare, review and share local files"),
    version(pkg.version),
    globalOptions,
    ready,
    watch,
    inspect,
    img,
    blog,
    video,
    share,
    paste,
    history,
    undo,
    doctor,
    init,
    gremlins,
    tunnel,
    jwt,
    dev,
  ),
  {
    // Bare `sv`: an overview for now; a natural home for an interactive menu later.
    run(intent, context) {
      context.stdout.write(
        `${printHelp({ ...intent, method: "help" })}\n\nStart here:\n  sv inspect <path>       See what a file or directory contains\n  sv ready <path>         Preview preparation without writing\n  sv img tune <image>     Compare image quality in an offline report\n  sv watch <path>         Recheck content as you edit\n  sv doctor               Check setup and optional tools\n\nRun sv <command> --help for options. Global --cwd and --verbose go before the command.\n`,
      );
    },
  },
);

export const app = createApp(sv, { context: createContext });
