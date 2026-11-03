import { beforeEach, describe, expect, test } from "bun:test";

import {
  argument,
  cli,
  command,
  extend,
  multiple,
  name,
  option,
  route,
  schema,
  toggle,
} from "@bomb.sh/router";
import { z } from "zod";

import { AppDefinitionError, createApp, defineCommand } from "../src/kit/index.ts";
import { fixtureApp } from "./fixtures/app.ts";
import { calls } from "./fixtures/tree.ts";
import { capture, runApp } from "./support/io.ts";

beforeEach(() => {
  calls.length = 0;
});

describe("dispatch", () => {
  test("executable root", async () => {
    const result = await runApp(fixtureApp(), ["--verbose", "--level", "3"]);
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe("/");
    expect(calls[0]?.model).toEqual({ verbose: true, name: undefined, level: 3 });
  });

  test("three levels deep, with defaults and every parameter kind", async () => {
    const result = await runApp(fixtureApp(), [
      "alpha",
      "beta",
      "gamma",
      "t1",
      "x1",
      "x2",
      "-m",
      "slow",
      "--tag",
      "red",
      "--tag=blue",
    ]);
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(calls[0]?.route).toBe("/alpha/beta/gamma");
    expect(calls[0]?.model).toEqual({
      target: "t1",
      extras: ["x1", "x2"],
      name: undefined,
      mode: "slow",
      tag: ["red", "blue"],
    });
  });

  test("ancestor models keep their own namespaces", async () => {
    await runApp(fixtureApp(), [
      "--name",
      "r",
      "alpha",
      "--name",
      "a",
      "beta",
      "--name",
      "b",
      "--force",
      "gamma",
      "--name",
      "g",
      "t",
    ]);
    expect(calls[0]?.inherited).toEqual({
      root: { verbose: false, name: "r", level: 1 },
      alpha: { name: "a" },
      beta: { name: "b", force: true },
    });
    expect(calls[0]?.models).toEqual({
      "/": { verbose: false, name: "r", level: 1 },
      "/alpha": { name: "a" },
      "/alpha/beta": { name: "b", force: true },
      "/alpha/beta/gamma": { target: "t", extras: [], name: "g", mode: "fast", tag: [] },
    });
  });

  test("similarly named options bind to the route whose segment contains them", async () => {
    await runApp(fixtureApp(), ["alpha", "beta", "--name", "only-beta", "gamma", "t"]);
    const models = calls[0]?.models as Record<string, { name?: string }>;
    expect(models["/"]?.name).toBeUndefined();
    expect(models["/alpha"]?.name).toBe("alpha");
    expect(models["/alpha/beta"]?.name).toBe("only-beta");
    expect(models["/alpha/beta/gamma"]?.name).toBeUndefined();
    expect(calls[0]?.inherited).toEqual({
      root: { verbose: false, name: undefined, level: 1 },
      alpha: { name: "alpha" },
      beta: { name: "only-beta", force: false },
    });
  });

  test("executable group runs its own handler", async () => {
    await runApp(fixtureApp(), ["alpha", "beta", "--force"]);
    expect(calls[0]?.route).toBe("/alpha/beta");
    expect(calls[0]?.model).toEqual({ name: undefined, force: true });
  });

  test("transform() reshapes the model the handler receives", async () => {
    await runApp(fixtureApp(), ["shaped", "--first", "Ada", "--last", "Lovelace"]);
    expect(calls[0]?.model).toEqual({ full: "Ada Lovelace" });
  });

  test("checkpoint() is driven by the app's driver; CLI input survives the pause", async () => {
    await runApp(fixtureApp(), ["config", "--config", "c.json"]);
    expect(calls[0]?.model).toEqual({ config: "c.json", port: 9000 });
    calls.length = 0;
    await runApp(fixtureApp(), ["config", "--port", "1"]);
    expect(calls[0]?.model).toEqual({ config: undefined, port: 1 });
  });

  test("dynamic() routes dispatch to handlers defined inside the extension", async () => {
    const result = await runApp(fixtureApp(), ["--name", "dynamic-root", "plugins", "world"]);
    expect(result.code).toBe(0);
    expect(calls.map((call) => call.route)).toEqual(["/plugins/world"]);
    expect(calls[0]?.inherited).toEqual({ root: { verbose: false, name: "dynamic-root", level: 1 } });
  });

  test("handler exit codes and thrown errors", async () => {
    const failing = defineCommand(command(name("x"), toggle(name("throw"))), {
      run: ({ model }) => {
        if (model.throw) throw new Error("boom");
        return 7;
      },
    });
    const app = createApp(failing);
    expect((await runApp(app, [])).code).toBe(7);
    expect(await runApp(app, ["--throw"])).toEqual({ code: 1, stdout: "", stderr: "x: boom\n" });
  });

  test("async handlers are awaited", async () => {
    const app = createApp(
      defineCommand(command(name("x")), {
        async run(_intent, context) {
          await Bun.sleep(1);
          context.stdout.write("done\n");
        },
      }),
    );
    expect(await runApp(app, [])).toEqual({ code: 0, stdout: "done\n", stderr: "" });
  });
});

describe("application context", () => {
  test("is built once per execution, from the base context and the intent", async () => {
    const stdout = capture();
    await fixtureApp().run(["--name", "ctx", "alpha", "beta"], { stdout, env: { A: "1" }, cwd: "/work" });
    const context = calls[0]?.context as Record<string, unknown>;
    expect(context["rootName"]).toBe("ctx");
    expect(context["program"]).toBe("fx");
    expect(context["cwd"]).toBe("/work");
    expect(context["env"]).toEqual({ A: "1" });
    expect(context["stdout"]).toBe(stdout);
    expect(context["signal"]).toBeInstanceOf(AbortSignal);
  });

  test("is not built for help, version, errors or completion", async () => {
    let built = 0;
    const app = createApp(
      defineCommand(command(name("x"), option(name("n"), schema(z.number()))), { run() {} }),
      {
        context: (base) => {
          built++;
          return base;
        },
      },
    );
    await runApp(app, ["--help"]);
    await runApp(app, ["--version"]);
    await runApp(app, ["--n", "nope"]);
    await runApp(app, ["complete", "--", ""]);
    app.complete(["--n", ""]);
    expect(built).toBe(0);
    await runApp(app, ["--n", "1"]);
    expect(built).toBe(1);
  });

  test("the abort signal is passed through", async () => {
    const controller = new AbortController();
    controller.abort();
    await fixtureApp().run([], { signal: controller.signal, stdout: capture() });
    expect((calls[0]?.context as { signal: AbortSignal }).signal.aborted).toBe(true);
  });
});

describe("help, version and errors", () => {
  test("help for any route, wherever --help appears", async () => {
    const root = await runApp(fixtureApp(), ["--help"]);
    expect(root.code).toBe(0);
    expect(root.stdout).toContain("fx 1.2.3");
    expect(root.stdout).toContain("alpha");
    const deep = await runApp(fixtureApp(), ["alpha", "--help", "beta", "gamma"]);
    expect(deep.stdout).toStartWith("alpha beta gamma\n");
    expect(deep.stdout).toContain("--mode, -m <VALUE>");
    expect(calls).toHaveLength(0);
  });

  test("version", async () => {
    expect(await runApp(fixtureApp(), ["-v"])).toEqual({ code: 0, stdout: "fx 1.2.3\n", stderr: "" });
  });

  test("version is a Router method: unsupported below the root", async () => {
    const result = await runApp(fixtureApp(), ["alpha", "--version"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("does not support VERSION");
  });

  test("a group without a handler prints its help to stderr", async () => {
    const result = await runApp(fixtureApp(), ["alpha"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("alpha\nGroup only");
    expect(result.stderr).toContain("beta");
  });

  test("schema validation errors never reach handlers", async () => {
    const result = await runApp(fixtureApp(), ["alpha", "beta", "gamma", "t", "--mode", "warp"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("mode: Invalid option");
    expect(result.stderr).toContain("Run `fx alpha beta gamma --help` for usage.");
    expect(calls).toHaveLength(0);
  });

  test("missing required values and unknown input", async () => {
    expect((await runApp(fixtureApp(), ["alpha", "beta", "gamma"])).stderr).toContain("target:");
    expect((await runApp(fixtureApp(), ["--level"])).stderr).toContain("--level requires a value");
    expect((await runApp(fixtureApp(), ["nope"])).stderr).toContain("unexpected: `nope`");
  });

  test("ancestor options after the child are rejected (Router scoping) with a hint", async () => {
    const result = await runApp(fixtureApp(), ["alpha", "beta", "gamma", "t", "--verbose"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unexpected: `--verbose`");
    expect(result.stderr).toContain("hint: --verbose is an option of `fx`; put it before `alpha`");
    const force = await runApp(fixtureApp(), ["alpha", "beta", "gamma", "t", "--force"]);
    expect(force.stderr).toContain("hint: --force is an option of `fx alpha beta`; put it before `gamma`");
    expect(calls).toHaveLength(0);
  });

  test("a parent flag the child also declares is the child's (no hint, no ambiguity)", async () => {
    await runApp(fixtureApp(), ["alpha", "beta", "gamma", "t", "--name", "mine"]);
    expect(calls[0]?.model).toMatchObject({ name: "mine" });
  });

  test("everything after -- is literal", async () => {
    const app = createApp(
      defineCommand(command(name("x"), argument(name("a"), schema(z.string().optional()))), {
        run({ literals, model }, context) {
          context.stdout.write(JSON.stringify({ model, literals: [...literals].map((t) => t.text) }));
        },
      }),
    );
    const result = await runApp(app, ["one", "--", "--help", "two"]);
    expect(JSON.parse(result.stdout)).toEqual({ model: { a: "one" }, literals: ["--help", "two"] });
  });

  test("checkpoint drivers run for help too (Router needs the full graph)", async () => {
    const result = await runApp(fixtureApp(), ["plugins", "hello", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toStartWith("plugins hello");
  });
});

describe("parse() and execute() expose Router's native results", () => {
  test("parse returns the settled intent without running anything", async () => {
    const result = await fixtureApp().parse(["alpha", "beta", "gamma", "t"]);
    expect(result.ok && result.method === "execute" && result.route).toBe("/alpha/beta/gamma");
    if (result.ok && result.method === "execute" && result.route === "/alpha/beta/gamma") {
      // Fully typed by Router: no casts.
      expect(result.models["/alpha"].name).toBe("alpha");
      expect(await fixtureApp().execute(result, { stdout: capture() })).toBe(0);
    }
    expect(calls).toHaveLength(1);
  });
});

describe("definition validation (runtime)", () => {
  const run = defineCommand(command(name("leaf")), { run() {} });

  function problems(build: () => unknown): readonly string[] {
    try {
      build();
    } catch (error) {
      if (error instanceof AppDefinitionError) return error.problems;
      throw error;
    }
    return [];
  }

  test("duplicate sibling names", () => {
    const tree = command(name("x"), route(name("g"), run, run));
    // @ts-expect-error caught at compile time too
    expect(problems(() => createApp(tree))).toContainEqual("/g/leaf: duplicate route name");
  });

  test("reserved root name and executable routes without handlers", () => {
    const tree = route(name("x"), route(name("complete")), command(name("bare")));
    // @ts-expect-error caught at compile time too
    const found = problems(() => createApp(tree));
    expect(found).toContainEqual(
      '/complete: "complete" is reserved at the root for shell completion requests',
    );
    expect(found).toContainEqual("/bare: executable command has no handler (wrap it with defineCommand())");
  });

  test("flags Router reserves, flags bound twice and unreachable arguments", () => {
    const leaf = defineCommand(
      command(
        name("leaf"),
        option(name("verbose"), cli(["--verbose", "-v"]), schema(z.string().optional())),
        option(name("out"), cli(["--out"])),
        option(name("output"), cli(["--output", "--out"])),
        argument(name("many"), multiple()),
        argument(name("after")),
      ),
      { run() {} },
    );
    expect(problems(() => createApp(leaf))).toEqual([
      '/: option "verbose" uses -v, which Router reserves for help/version',
      '/: --out is bound by both "out" and "output"',
      '/: argument "after" follows variadic argument "many" and can never receive a value',
    ]);
  });

  test("inherited bundles must have an applier on the mount path", () => {
    const opts = extend(toggle(name("deep")));
    const leaf = defineCommand(command(name("leaf")), { inherit: { group: opts }, run() {} });
    const tree = route(name("x"), route(name("other"), leaf));
    // @ts-expect-error caught at compile time too
    expect(problems(() => createApp(tree))).toContainEqual(
      '/other/leaf: inherits "group", but no route on this path applies that bundle',
    );
  });

  test("same-shape bundles require parameter identity", () => {
    const applied = extend(toggle(name("enabled")));
    const other = extend(toggle(name("enabled")));
    const leaf = defineCommand(command(name("leaf")), { inherit: { other }, run() {} });
    expect(problems(() => createApp(route(name("x"), applied, leaf)))).toEqual([
      '/leaf: inherits "other", but no route on this path applies that bundle',
    ]);
  });

  test("empty bundles cannot be inherited", () => {
    const empty = extend();
    const leaf = defineCommand(command(name("leaf")), { inherit: { empty }, run() {} });
    expect(problems(() => createApp(route(name("x"), empty, leaf)))).toEqual([
      '/leaf: inherits "empty", which declares no parameters',
    ]);
  });

  test("route names must be single words", () => {
    const tree = route(name("x"), route(name("two words")), route(name("-dash")));
    expect(problems(() => createApp(tree))).toEqual([
      '/two words: route name "two words" must be a single word that does not start with "-"',
      '/-dash: route name "-dash" must be a single word that does not start with "-"',
    ]);
  });
});

describe("instances", () => {
  test("independent apps do not share state", async () => {
    const a = createApp(defineCommand(command(name("a"), toggle(name("one"))), { run: () => 1 }));
    const b = createApp(defineCommand(command(name("b"), toggle(name("two"))), { run: () => 2 }));
    expect((await runApp(a, [])).code).toBe(1);
    expect((await runApp(b, [])).code).toBe(2);
    expect((await runApp(a, ["--two"])).code).toBe(2);
    expect(a.complete(["--"]).candidates.map((c) => c.value)).toEqual(["--one", "--no-one", "--help"]);
    expect(b.complete(["--"]).candidates.map((c) => c.value)).toEqual(["--two", "--no-two", "--help"]);
  });
});

describe("bundle resolution", () => {
  test("the nearest application wins, including the command itself", async () => {
    const options = extend(option(name("value"), schema(z.string().default("default"))));
    const received: unknown[] = [];
    const leaf = defineCommand(command(name("leaf")), {
      inherit: { options },
      run(_intent, _context, inherited) {
        received.push(inherited.options);
      },
    });
    const own = defineCommand(command(name("own"), options), {
      inherit: { options },
      run(_intent, _context, inherited) {
        received.push(inherited.options);
      },
    });
    const app = createApp(route(name("x"), options, route(name("group"), options, leaf, own)));
    expect((await runApp(app, ["--value", "root", "group", "--value", "group", "leaf"])).code).toBe(0);
    expect(
      (await runApp(app, ["--value", "root", "group", "--value", "group", "own", "--value", "own"])).code,
    ).toBe(0);
    expect(received).toEqual([{ value: "group" }, { value: "own" }]);
  });

  test("one command can inherit from either mount group", async () => {
    const options = extend(option(name("value"), schema(z.string())));
    const received: unknown[] = [];
    const leaf = defineCommand(command(name("leaf")), {
      inherit: { options },
      run(_intent, _context, inherited) {
        received.push(inherited.options);
      },
    });
    const app = createApp(route(name("x"), route(name("a"), options, leaf), route(name("b"), options, leaf)));
    expect((await runApp(app, ["a", "--value", "first", "leaf"])).code).toBe(0);
    expect((await runApp(app, ["b", "--value", "second", "leaf"])).code).toBe(0);
    expect(received).toEqual([{ value: "first" }, { value: "second" }]);
  });
});
