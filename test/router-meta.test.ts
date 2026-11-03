/**
 * Pins the Router behaviour the integration depends on but Router does not
 * document as a stable introspection API. If a Router upgrade breaks one of
 * these, fix `src/kit/router-meta.ts` (the only module that reads them).
 */

import { describe, expect, test } from "bun:test";

import {
  argument,
  checkpoint,
  cli,
  command,
  description,
  dynamic,
  extend,
  mark,
  multiple,
  name,
  option,
  type Param,
  parse,
  route,
  schema,
  toggle,
  type Transform,
  version,
} from "@bomb.sh/router";
import { z } from "zod";

import { handlerOf } from "../src/kit/command.ts";
import { completionOf } from "../src/kit/complete.ts";
import { complete, defineCommand, describeRoute, flattenRoutes, type ParamMeta } from "../src/kit/index.ts";
import { findApplier, paramsOf } from "../src/kit/router-meta.ts";

interface Same extends Transform {
  readonly input: Param<string, unknown, "one">;
  readonly output: this["input"];
}

/** Replace a parameter's CLI binding with a hand-written reader. */
function binding(label: string | undefined, accepts: string) {
  return mark<Same>((param: object) => ({
    ...param,
    cli: {
      read: (
        tokens: Parameters<ReturnType<typeof describeRoute>["params"][number]["param"]["cli"]["read"]>[0],
      ) => {
        const claim = tokens.claimOne((token) => token.type === "flag" && token.text === accepts);
        return {
          claim,
          result: {
            ok: true as const,
            value: claim.tokens[0] ? { exists: true, value: true } : { exists: false },
            issues: [],
          },
        };
      },
      ...(label === undefined ? {} : { syntax: { type: "option" as const, label } }),
    },
  }));
}

function shape(params: readonly ParamMeta[]) {
  return params.map((param) => ({
    name: param.name,
    kind: param.kind,
    multiple: param.multiple,
    description: param.description,
    flags:
      param.kind === "option"
        ? param.flags.map((flag) => [flag.text, flag.takesValue, flag.sets])
        : undefined,
  }));
}

describe("parameters", () => {
  test("every parameter kind, with flags verified by probing Router's reader", () => {
    const meta = describeRoute(
      command(
        name("x"),
        option(name("dryRun"), description("Kebab-cased")),
        toggle(name("verbose")),
        option(name("repository"), cli(["--repo", "-R"])),
        option(name("web"), cli(["--web", "-w"], { switch: true })),
        option(name("label"), multiple()),
        argument(name("input")),
        argument(name("files"), multiple()),
      ),
    );
    expect(shape(meta.params)).toEqual([
      {
        name: "dryRun",
        kind: "option",
        multiple: false,
        description: "Kebab-cased",
        flags: [["--dry-run", true, undefined]],
      },
      {
        name: "verbose",
        kind: "option",
        multiple: false,
        description: undefined,
        flags: [
          ["--verbose", false, true],
          ["--no-verbose", false, false],
        ],
      },
      {
        name: "repository",
        kind: "option",
        multiple: false,
        description: undefined,
        // `cli()` replaces the default: `--repository` is no longer accepted.
        flags: [
          ["--repo", true, undefined],
          ["-R", true, undefined],
        ],
      },
      {
        name: "web",
        kind: "option",
        multiple: false,
        description: undefined,
        flags: [
          ["--web", false, true],
          ["-w", false, true],
        ],
      },
      {
        name: "label",
        kind: "option",
        multiple: true,
        description: undefined,
        flags: [["--label", true, undefined]],
      },
      { name: "input", kind: "argument", multiple: false, description: undefined, flags: undefined },
      { name: "files", kind: "argument", multiple: true, description: undefined, flags: undefined },
    ]);
  });

  test("labels are only candidates: the reader decides", () => {
    const meta = describeRoute(
      command(
        name("x"),
        // Label lies: claims --shown, accepts --real (not derivable) → unbound.
        option(name("liar"), binding("--shown", "--real")),
        // No label at all, but Router's default name works → found by probing.
        option(name("quiet"), binding(undefined, "--quiet")),
      ),
    );
    expect(shape(meta.params).map(({ name: param, kind, flags }) => ({ param, kind, flags }))).toEqual([
      { param: "liar", kind: "unbound", flags: undefined },
      { param: "quiet", kind: "option", flags: [["--quiet", false, true]] },
    ]);
  });

  test("complete() survives later parameter elements", () => {
    const meta = describeRoute(
      command(
        name("x"),
        option(name("a"), complete(["1"]), schema(z.string()), cli(["--b"]), description("d")),
      ),
    );
    const [param] = meta.params;
    expect(param && completionOf(param.param)).toEqual(["1"]);
  });
});

describe("routes", () => {
  test("paths, methods, versions, descriptions and children across phases", () => {
    const meta = describeRoute(
      command(
        name("x"),
        version("1.0.0"),
        route(name("group"), description("A group"), command(name("leaf"))),
        option(name("before")),
        checkpoint(),
        option(name("after")),
        command(name("late")),
      ),
    );
    expect(
      flattenRoutes(meta).map((r) => [r.path, r.methods.toSorted(), r.version, r.description, r.dynamic]),
    ).toEqual([
      ["/", ["execute", "help", "version"], "1.0.0", undefined, true],
      ["/group", ["help"], undefined, "A group", false],
      ["/group/leaf", ["execute", "help"], undefined, undefined, false],
      ["/late", ["execute", "help"], undefined, undefined, false],
    ]);
    expect(meta.params.map((p) => p.name)).toEqual(["before", "after"]);
  });
});

describe("Router contracts the runtime relies on", () => {
  const leaf = defineCommand(command(name("leaf")), { run() {} });
  const tree = command(name("x"), route(name("g"), leaf));

  test("intent.definition is the mounted route object, handler included", () => {
    const result = parse(tree, { argv: ["g", "leaf"] });
    if (!result.ok || "resume" in result) throw new Error("expected an intent");
    expect(handlerOf(result.definition)).toBe(handlerOf(leaf));
  });

  test("dynamic continuations keep extra properties of the paused route", () => {
    const handled = defineCommand(
      command(
        name("p"),
        dynamic(z.array(z.string()), () => extend()),
      ),
      { run() {} },
    );
    const step = parse(handled, { argv: [] });
    if (!step.ok || !("resume" in step)) throw new Error("expected a paused parse");
    const result = step.resume([]);
    expect(result.ok && result.method === "execute" && handlerOf(result.definition)).toBe(handlerOf(handled));
  });

  test("-h, --help, -v and --version are claimed anywhere before --", () => {
    for (const argv of [
      ["g", "-h"],
      ["--help", "g"],
      ["g", "leaf", "-h"],
    ]) {
      const result = parse(tree, { argv });
      expect(result.ok && "method" in result && result.method).toBe("help");
    }
    const versioned = parse(command(name("v"), version("1")), { argv: ["-v"] });
    expect(versioned.ok && versioned.method).toBe("version");
  });

  test("route selection is by the first word naming a child; later words belong to the child", () => {
    const result = parse(command(name("x"), toggle(name("v2")), route(name("g"), leaf)), {
      argv: ["g", "--v2", "leaf"],
    });
    // --v2 sits inside the /g segment, which does not declare it.
    expect(result.ok).toBe(false);
  });
});

test("bundle parameters retain identity at every application", () => {
  const single = toggle(name("enabled"));
  const bundle = extend(single, option(name("value"), schema(z.string())));
  const meta = describeRoute(route(name("x"), bundle, route(name("group"), bundle, command(name("leaf")))));
  const routes = flattenRoutes(meta);
  const params = paramsOf(bundle);
  expect(params).toHaveLength(2);
  expect(paramsOf(single)[0]).toBe(params[0]);
  for (const applied of routes.slice(0, 2)) {
    expect(applied.params).toHaveLength(2);
    applied.params.forEach((param, index) => {
      const expected = params[index];
      if (!expected) throw new Error("missing bundle parameter");
      expect(param.param).toBe(expected);
    });
  }
  expect(findApplier(bundle, routes)).toBe(routes[1]);
  expect(findApplier(bundle, routes.slice(0, 1))).toBe(routes[0]);
  expect(findApplier(extend(toggle(name("enabled"))), routes)).toBeUndefined();
  expect(findApplier(extend(), routes)).toBeUndefined();
});
