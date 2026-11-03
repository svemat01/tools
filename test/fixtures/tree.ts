/**
 * A fixture tree exercising every composition feature against the real
 * Router and Tab. Handlers record what they received instead of printing.
 *
 *   fx [--verbose] [--name <v>] [--level <n>]          executable root, version
 *   ├─ alpha [--name <v>]                              group only (route)
 *   │  └─ beta [--name <v>] [--force]                  executable group (command)
 *   │     └─ gamma <target> [extras...] [--name <v>] [--mode|-m <m>] [--tag <t>]...
 *   ├─ files <src> [--dir <d>] [--any <p>]             path completions
 *   ├─ native <thing>                                  native Tab handler + per-command hook
 *   ├─ shaped [--first <a>] [--last <b>]               transform() reshapes the model
 *   ├─ config [--config <file>] ⏸ [--port <n>]          checkpoint()
 *   └─ plugins ⏸ <dynamic commands>                     dynamic()
 */

import {
  argument,
  checkpoint,
  cli,
  command,
  description,
  dynamic,
  extend,
  multiple,
  name,
  option,
  route,
  schema,
  toggle,
  transform,
  version,
} from "@bomb.sh/router";
import { z } from "zod";

import { complete, defineCommand, directories, files } from "../../src/kit/index.ts";
import type { BaseContext } from "../../src/kit/index.ts";

export interface Call {
  readonly route: string;
  readonly model: unknown;
  readonly models: unknown;
  readonly context: unknown;
  readonly inherited: unknown;
}

/** Handlers append here; tests reset it. */
export const calls: Call[] = [];

function record(
  intent: { route: string; model: unknown; models: unknown },
  context: unknown,
  inherited: unknown = {},
): void {
  calls.push({ route: intent.route, model: intent.model, models: intent.models, context, inherited });
}

export const rootOptions = extend(
  toggle(name("verbose"), description("Verbose output")),
  option(
    name("name"),
    description("Root name"),
    schema(z.string().optional()),
    complete(["root-a", "root-b"]),
  ),
  option(name("level"), schema(z.number().int().default(1))),
);

export const alphaOptions = extend(
  option(name("name"), description("Alpha name"), schema(z.string().default("alpha")), complete(["alpha-a"])),
);

export const betaOptions = extend(
  option(name("name"), description("Beta name"), schema(z.string().optional()), complete(["beta-a"])),
  toggle(name("force")),
);

export const gamma = defineCommand(
  command(
    name("gamma"),
    description("Third level"),
    argument(name("target"), description("Target"), schema(z.string()), complete(["t1", "t2"])),
    argument(name("extras"), multiple(), schema(z.array(z.string()).default([])), complete(["x1", "x2"])),
    option(name("name"), description("Gamma name"), schema(z.string().optional()), complete(["gamma-a"])),
    option(
      name("mode"),
      cli(["--mode", "-m"]),
      schema(z.enum(["fast", "slow"]).default("fast")),
      complete([
        { value: "fast", description: "Go fast" },
        { value: "slow", description: "Go slow" },
      ]),
    ),
    option(name("tag"), multiple(), schema(z.array(z.string()).default([])), complete(["red", "blue"])),
  ),
  {
    inherit: { root: rootOptions, alpha: alphaOptions, beta: betaOptions },
    run: (intent, context, inherited) => record(intent, context, inherited),
  },
);

export const beta = defineCommand(
  command(name("beta"), description("Executable group"), betaOptions, gamma),
  {
    inherit: { alpha: alphaOptions },
    run: (intent, context, inherited) => record(intent, context, inherited),
  },
);

export const alpha = route(name("alpha"), description("Group only"), alphaOptions, beta);

export const filesCommand = defineCommand(
  command(
    name("files"),
    argument(name("src"), schema(z.string().optional()), complete(files({ extensions: ["png", ".jpg"] }))),
    option(name("dir"), schema(z.string().optional()), complete(directories())),
    option(name("any"), schema(z.string().optional()), complete(files())),
  ),
  { run: (intent, context, inherited) => record(intent, context, inherited) },
);

export const native = defineCommand(
  command(
    name("native"),
    argument(
      name("thing"),
      schema(z.string().optional()),
      // A native Tab handler: receives Tab's `this`, `complete` and options map.
      complete(function (add, options) {
        add(`from-${this instanceof Object ? "tab" : "?"}`, `options: ${options.size}`);
      }),
    ),
  ),
  {
    run: (intent, context, inherited) => record(intent, context, inherited),
    // Per-command native hook: add an option Router does not know about.
    tab(command) {
      command.option("extra", "Added through the native Tab API", (add) => add("native-extra", ""));
    },
  },
);

export const shaped = defineCommand(
  command(
    name("shaped"),
    option(name("first"), schema(z.string().default("a")), complete(["key:value", "plain"])),
    option(name("last"), schema(z.string().default("b"))),
    // Model fields no longer match parameter names after this.
    transform(
      z
        .object({ first: z.string(), last: z.string() })
        .transform(({ first, last }) => ({ full: `${first} ${last}` })),
    ),
  ),
  { run: (intent, context, inherited) => record(intent, context, inherited) },
);

export const config = defineCommand(
  command(
    name("config"),
    option(name("config"), schema(z.string().optional()), complete(files({ extensions: ["json"] }))),
    checkpoint(),
    option(name("port"), schema(z.number().int().default(3000)), complete(["3000", "8080"])),
  ),
  { run: (intent, context, inherited) => record(intent, context, inherited) },
);

export const plugins = defineCommand(
  command(
    name("plugins"),
    dynamic(z.array(z.string()), (names) =>
      extend(
        ...names.map((plugin) =>
          defineCommand(command(name(plugin)), {
            inherit: { root: rootOptions },
            run: (intent, context, inherited) => record(intent, context, inherited),
          }),
        ),
      ),
    ),
  ),
  { run: (intent, context, inherited) => record(intent, context, inherited) },
);

export const fx = defineCommand(
  command(
    name("fx"),
    description("Fixture CLI"),
    version("1.2.3"),
    rootOptions,
    alpha,
    filesCommand,
    native,
    shaped,
    config,
    plugins,
  ),
  { run: (intent, context: BaseContext) => record(intent, context) },
);
