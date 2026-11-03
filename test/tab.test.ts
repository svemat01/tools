import { beforeEach, describe, expect, test } from "bun:test";

import { command, name, option, schema, toggle } from "@bomb.sh/router";
import t, { Option, RootCommand, ShellCompDirective } from "@bomb.sh/tab";
import { z } from "zod";

import { complete, createApp, defineCommand } from "../src/kit/index.ts";
import { drive, fixtureApp } from "./fixtures/app.ts";
import { calls, fx } from "./fixtures/tree.ts";
import { runApp, values } from "./support/io.ts";

const { ShellCompDirectiveDefault, ShellCompDirectiveNoFileComp, ShellCompDirectiveFilterFileExt } =
  ShellCompDirective;

beforeEach(() => {
  calls.length = 0;
});

describe("generated native Tab tree", () => {
  const tree = fixtureApp().tab();

  test("is a fresh RootCommand with every static route, keyed the way Tab expects", () => {
    expect(tree.root).toBeInstanceOf(RootCommand);
    expect([...tree.root.commands.keys()]).toEqual([
      "alpha",
      "alpha beta",
      "alpha beta gamma",
      "files",
      "native",
      "shaped",
      "config",
      "plugins",
    ]);
    expect(tree.root.commands.get("alpha beta")).toBe(tree.command("/alpha/beta"));
    expect(tree.command("/")).toBe(tree.root);
    expect(tree.root.commands.get("alpha")?.description).toBe("Group only");
  });

  test("options: descriptions, booleans, values, aliases, negations, help and version", () => {
    const root = tree.root.options;
    expect([...root.keys()]).toEqual(["verbose", "no-verbose", "name", "level", "help", "version"]);
    expect(root.get("verbose")).toMatchObject({ description: "Verbose output", isBoolean: true });
    expect(root.get("no-verbose")).toMatchObject({ description: "Turn off --verbose", isBoolean: true });
    expect(root.get("name")).toMatchObject({ description: "Root name", isBoolean: false });
    expect(root.get("help")).toMatchObject({ alias: "h", isBoolean: true });
    expect(root.get("version")).toMatchObject({ alias: "v", isBoolean: true });

    const gamma = tree.command("/alpha/beta/gamma").options;
    expect(gamma.get("mode")).toMatchObject({ alias: "m", isBoolean: false });
    expect(gamma.has("version")).toBe(false);
  });

  test("arguments keep declaration order and variadic-ness", () => {
    const args = [...tree.command("/alpha/beta/gamma").arguments.values()];
    expect(args.map((arg) => [arg.name, arg.variadic])).toEqual([
      ["target", false],
      ["extras", true],
    ]);
  });

  test("parameters after a checkpoint are known statically", () => {
    expect([...tree.command("/config").options.keys()]).toEqual(["config", "port", "help"]);
  });

  test("per-command and app-level hooks receive the native objects", () => {
    expect(tree.command("/native").options.get("extra")).toBeInstanceOf(Option);

    const app = createApp(fx, {
      checkpoint: drive,
      tab(native) {
        native.command("/alpha").option("legacy", "Old flag", (add) => add("yes", ""));
        native.root.command("external", "Not a Router route");
        // Type-only: route paths are checked against the tree.
        // @ts-expect-error "/alpha/nope" is not a route of fx
        const invalid = () => native.command("/alpha/nope");
        void invalid;
      },
    });
    expect(values(app, ["alpha", "--legacy", ""])).toEqual(["yes"]);
    expect(values(app, ["ext"])).toEqual(["external"]);
  });

  test("never touches Tab's global default instance", () => {
    fixtureApp().complete(["alpha", ""]);
    expect(t.commands.size).toBe(0);
    expect(t.options.size).toBe(0);
  });
});

describe("completion requests", () => {
  const app = fixtureApp();

  test("protocol output", () => {
    expect(app.complete(["alpha", "beta", "gamma", "--mode", ""]).output).toBe(
      `fast\tGo fast\nslow\tGo slow\n:${ShellCompDirectiveNoFileComp}\n`,
    );
  });

  test("commands at every depth, including incomplete words", () => {
    expect(values(app, [""])).toEqual(["alpha", "files", "native", "shaped", "config", "plugins"]);
    expect(values(app, ["al"])).toEqual(["alpha"]);
    expect(values(app, ["alpha", ""])).toEqual(["beta"]);
    expect(values(app, ["alpha", "be"])).toEqual(["beta"]);
    expect(values(app, ["alpha", "beta", ""])).toEqual(["gamma"]);
    expect(values(app, ["zzz", ""])).toEqual([]);
  });

  test("flags are scoped to the matched route", () => {
    expect(values(app, ["--"])).toEqual([
      "--verbose",
      "--no-verbose",
      "--name",
      "--level",
      "--help",
      "--version",
    ]);
    expect(values(app, ["alpha", "beta", "gamma", "--"])).toEqual(["--name", "--mode", "--tag", "--help"]);
    expect(values(app, ["alpha", "beta", "gamma", "-"])).toEqual(["-m", "-h"]);
    expect(values(app, ["alpha", "-"])).toEqual(["-h"]);
    expect(values(app, ["alpha", "beta", "gamma", "--m"])).toEqual(["--mode"]);
  });

  test("same option name at four levels completes the right values", () => {
    expect(values(app, ["--name", ""])).toEqual(["root-a", "root-b"]);
    expect(values(app, ["alpha", "--name", ""])).toEqual(["alpha-a"]);
    expect(values(app, ["alpha", "beta", "--name", ""])).toEqual(["beta-a"]);
    expect(values(app, ["alpha", "beta", "gamma", "--name", ""])).toEqual(["gamma-a"]);
  });

  test("option values with a space, with =, and through a short alias", () => {
    expect(values(app, ["alpha", "beta", "gamma", "--mode", "s"])).toEqual(["slow"]);
    expect(values(app, ["alpha", "beta", "gamma", "--mode="])).toEqual(["fast", "slow"]);
    expect(values(app, ["alpha", "beta", "gamma", "--mode=f"])).toEqual(["fast"]);
    expect(values(app, ["alpha", "beta", "gamma", "-m", ""])).toEqual(["fast", "slow"]);
  });

  test("positionals: order, variadic repetition, and options in between", () => {
    expect(values(app, ["alpha", "beta", "gamma", ""])).toEqual(["t1", "t2"]);
    expect(values(app, ["alpha", "beta", "gamma", "t1", ""])).toEqual(["x1", "x2"]);
    expect(values(app, ["alpha", "beta", "gamma", "t1", "x1", ""])).toEqual(["x1", "x2"]);
    expect(values(app, ["alpha", "beta", "gamma", "--mode", "fast", ""])).toEqual(["t1", "t2"]);
    expect(values(app, ["alpha", "beta", "gamma", "-m", "fast", "t1", ""])).toEqual(["x1", "x2"]);
  });

  test("an earlier --name=value does not swallow the next word", () => {
    expect(values(app, ["alpha", "beta", "gamma", "--mode=fast", ""])).toEqual(["t1", "t2"]);
    expect(values(app, ["--name=x", "al"])).toEqual(["alpha"]);
    expect(values(app, ["alpha", "--name=x", "beta", ""])).toEqual(["gamma"]);
  });

  test("ancestor options before the child command", () => {
    expect(values(app, ["--name", "x", "al"])).toEqual(["alpha"]);
    expect(values(app, ["--verbose", ""])).toEqual([
      "alpha",
      "files",
      "native",
      "shaped",
      "config",
      "plugins",
    ]);
    expect(values(app, ["--no-verbose", "alpha", ""])).toEqual(["beta"]);
    expect(values(app, ["alpha", "--name", "x", "beta", "--force", ""])).toEqual(["gamma"]);
  });

  test("repeated options", () => {
    expect(values(app, ["alpha", "beta", "gamma", "--tag", "red", "--tag", ""])).toEqual(["red", "blue"]);
  });

  test("after -- (Router literals) nothing is suggested and the shell may complete paths", () => {
    const result = app.complete(["alpha", "beta", "gamma", "--", "--m"]);
    expect(result.candidates).toEqual([]);
    expect(result.directive).toBe(ShellCompDirectiveDefault);
  });

  test("native path completion directives", () => {
    expect(app.complete(["files", ""])).toMatchObject({
      candidates: [{ value: "png" }, { value: "jpg" }],
      directive: ShellCompDirectiveFilterFileExt,
    });
    expect(app.complete(["files", "--dir", ""])).toMatchObject({ candidates: [], directive: 16 });
    expect(app.complete(["files", "--dir="])).toMatchObject({ candidates: [], directive: 16 });
    expect(app.complete(["files", "--any", ""])).toMatchObject({ candidates: [], directive: 0 });
    expect(app.complete(["config", "--config", ""])).toMatchObject({
      directive: ShellCompDirectiveFilterFileExt,
    });
    // Without a path completion Tab's own directive (no file fallback) stays.
    expect(app.complete(["alpha", "beta", "gamma", "--name", "zz"]).directive).toBe(
      ShellCompDirectiveNoFileComp,
    );
  });

  test("parameters after a checkpoint complete without running the driver", () => {
    expect(values(app, ["config", "--port", ""])).toEqual(["3000", "8080"]);
  });

  test("routes added by dynamic() only exist after resume(), so they are not completed", () => {
    expect(values(app, ["plugins", ""])).toEqual([]);
  });

  test("native Tab handlers get Tab's this, add() and the options map", () => {
    expect(app.complete(["native", ""]).candidates).toEqual([
      { value: "from-tab", description: "options: 2" },
    ]);
    expect(values(app, ["native", "--extra", ""])).toEqual(["native-extra"]);
  });

  test("help and version flags", () => {
    expect(values(app, ["-"])).toEqual(["-h", "-v"]);
    expect(values(app, ["--help", ""])).toEqual(["alpha", "files", "native", "shaped", "config", "plugins"]);
  });

  test("completion never executes handlers or the checkpoint driver", async () => {
    let driven = 0;
    const spied = createApp(fx, {
      checkpoint: (step) => {
        driven++;
        return drive(step);
      },
    });
    for (const words of [
      [""],
      ["plugins", "hello", ""],
      ["config", "--config", "x", ""],
      ["alpha", "beta", ""],
    ]) {
      spied.complete(words);
      await runApp(spied, ["complete", "--", ...words]);
    }
    expect(calls).toEqual([]);
    expect(driven).toBe(0);
  });

  test("a throwing completion handler yields the Error directive, not a crash", () => {
    const broken = createApp(
      defineCommand(
        command(
          name("x"),
          option(
            name("v"),
            complete(() => {
              throw new Error("nope");
            }),
          ),
        ),
        { run() {} },
      ),
    );
    expect(broken.complete(["--v", ""])).toEqual({ candidates: [], directive: 1, output: ":1\n" });
  });

  test("the complete command speaks the protocol", async () => {
    expect(await runApp(app, ["complete", "--", "alpha", ""])).toEqual({
      code: 0,
      stdout: "beta\tExecutable group\n:4\n",
      stderr: "",
    });
    const usage = await runApp(app, ["complete", "nushell"]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("Usage: fx complete <zsh|bash|fish|powershell>");
  });
});

describe("known upstream limitations (Tab 0.0.22)", () => {
  test("option arity is resolved from the root first (bombshell-dev/tab#153)", () => {
    // Root `--force` is boolean; the child's `--force` takes a value. Router
    // scopes them correctly, but Tab decides arity root-first for the whole
    // line, so the child's values are not offered. Fixed upstream by #154.
    const app = createApp(
      defineCommand(
        command(
          name("x"),
          toggle(name("force")),
          defineCommand(command(name("child"), option(name("force"), schema(z.string()), complete(["a"]))), {
            run() {},
          }),
        ),
        { run() {} },
      ),
    );
    expect(values(app, ["child", "--force", ""])).toEqual([]);
  });
});
