[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Development

sv uses [Bun](https://bun.com), [`@bomb.sh/router`](https://bomb.sh/docs/router/) and [`@bomb.sh/tab`](https://bomb.sh/docs/tab/). `src/kit/` integrates native Router definitions with typed dispatch and shell completion. Library intents, models, printers and Tab command objects remain accessible.

## Install and verify

```bash
bun install --frozen-lockfile
bun run verify
```

| Task                         | Command                       |
| ---------------------------- | ----------------------------- |
| Runtime and shell tests      | `bun test`                    |
| Types, including type tests  | `bun check`                   |
| Lint                         | `bun lint`                    |
| Format / check formatting    | `bun fmt` / `bun fmt --check` |
| Full verification            | `bun run verify`              |
| Regenerate command reference | `bun run docs:generate`       |
| Check reference drift        | `bun run docs:check`          |

The exact Bun toolchain is pinned as a development dependency, including canary lint support. Run through package scripts after installing to use the pinned tools. The [command reference](reference.md) is generated from the native help output; update it when command help changes. Real-shell tests skip when the relevant shell/dependencies are unavailable; CI installs Zsh and bash-completion. Some restricted sandboxes prevent Bun subprocess stdout or loopback listeners; verify the same tests outside that sandbox before treating those environment failures as code regressions.

## Keep the command reference current

`docs/reference.md` is generated from the same native `--help` output users see. Change option names/descriptions in command definitions, then run:

```bash
bun run docs:generate
bun run docs:check
bun run verify
```

Commit the generated file alongside command changes. Do not hand-edit option lists in the generated reference. `verify` includes the drift check, and CI runs `docs:check` after the tests, so stale help documentation fails verification. Workflow guides remain hand-written: update examples, behavior and limits when a feature changes.

## Adding a command

1. **Define it with Router and attach a handler.** Everything in `command(...)` is plain `@bomb.sh/router`, and the handler's input is inferred from it.

   ```ts
   // src/commands/img/thumb.ts
   import { argument, command, description, name, option, schema } from "@bomb.sh/router";
   import { z } from "zod";

   import { complete, defineCommand, files } from "../../kit/index.ts";

   export const thumb = defineCommand(
     command(
       name("thumb"),
       description("Make a thumbnail"),
       argument(name("input"), schema(z.string()), complete(files({ extensions: ["png", "jpg"] }))),
       option(name("size"), schema(z.number().int().default(256)), complete(["128", "256", "512"])),
     ),
     {
       run({ model }, context) {
         // model: { input: string; size: number }
         context.stdout.write(`${model.input} @ ${model.size}px\n`);
       },
     },
   );
   ```

To read parent options, export a bundle from its own module, declare `inherit: { img: imgOptions }`, and read `img` from the handler’s third argument.

2. **Mount it** inside its group, which is again plain Router: `route(name("img"), imgOptions, web, og, resize, compare, info, thumb)`.

3. **Run `bun check && bun test`.** If the command can't work where you mounted it, `bun check` fails at `createApp(...)` in `src/app.ts` and names the route. That covers a missing handler, an inherited bundle without an applier, missing context services, duplicate names, a widened route type, and a missing checkpoint driver.

There is nothing else to register: dispatch, help, and completion all come from the definition.

### Groups and nesting

| You want                              | Write                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| A group that only contains commands   | `route(name("img"), ...children)`; bare `sv img` prints its help                |
| A command that also has subcommands   | `defineCommand(command(name("dev"), ...options, ...children), { run })`         |
| An executable root (`sv` alone)       | `defineCommand(command(name("sv"), ...), { run })`                              |
| A reusable bundle of options/children | `extend(...)` (Router)                                                          |
| Children from a module, as a list     | `export const commands = [a, b] as const`, then `route(name("x"), ...commands)` |

Keep child lists as tuples. A plain `AnyRoute[]` throws away every path and model type, and `createApp` rejects it.

### Parent options: `inherit`

Router scopes every option to the route that declares it. A command declares the option bundles it reads under local aliases; the handler receives their typed models as its third argument:

```ts
// src/commands/img/options.ts — its own module, so children can import it
export const imgOptions = extend(option(name("quality"), schema(z.number().int().default(80))));

// src/commands/img/web.ts
export const web = defineCommand(
  command(name("web"), option(name("quality"), schema(z.number().optional()))),
  {
    inherit: { img: imgOptions },
    run({ model }, _context, { img }) {
      const quality = model.quality ?? img.quality; // number | undefined, then number
    },
  },
);
```

`createApp` checks that a route on the mount path provides a compatible model. Runtime validation requires the exact bundle, by parameter identity. A different bundle with the same shape passes the type check but fails runtime validation. The nearest route applying the bundle wins, including the command itself and root. Namespaces stay separate: `img.quality` and `model.quality` above.

Commands no longer depend on mount paths: moving a group does not break its children, and handlers do not index models by path strings. Keep parent bundles in their own module to avoid circular imports.

**Option position follows Router.** Parent options go before the child's name:

```bash
sv --verbose img web cat.png --quality 40      # ok
sv img web cat.png --verbose                   # error: unexpected `--verbose`
                                               # hint: --verbose is an option of `sv`; put it before `img`
```

This was a deliberate choice; see [architecture](architecture.md#option-position).

### Application context

Handlers get a second argument: the context. By default it's `BaseContext` (`program`, `stdout`, `stderr`, `env`, `cwd`, `signal`), and tests replace these through `app.run(argv, { stdout, env, cwd, ... })`. Application services live in `src/context.ts`, including injectable `confirm()` and `readStdin()` functions. Prompts use stderr so JSON stdout stays parseable. A handler that needs them annotates the parameter:

```ts
run({ model }, context: AppContext) {
  context.log.debug("...");
}
```

`createApp(sv, { context: createContext })` builds the context once per executed command, never for help, errors or completion. It receives the execute intent, so root options like `--verbose` can configure services without being flattened into the context. The factory's return type is checked against every handler's declared context.

### Completion

Completion is derived from the Router definitions: subcommands, descriptions, options and their aliases, boolean versus value-taking flags, `--no-x` negations, positional and variadic arguments, and `--help`/`--version`. Values are **never** guessed from schemas. Where you want candidates, add `complete()` to the parameter, next to `schema()`:

```ts
option(name("format"), schema(z.enum(["webp", "avif"])), complete(["webp", "avif"]));
option(name("theme"), complete([{ value: "dark", description: "Dark theme" }]));
argument(name("input"), complete(files({ extensions: ["png"] }))); // shell-native, handles spaces and dirs
option(name("cwd"), complete(directories()));
option(
  name("branch"),
  complete(function (add) {
    // a native Tab handler
    for (const branch of listBranches()) add(branch, ""); // `this` is Tab's Option/Argument
  }),
);
```

Because the completion is attached to the parameter, renaming the flag with `cli()` or reshaping the model with `transform()` can't break the link.

**Native Tab access.** Two hooks hand you Tab's own objects after generation:

```ts
// per command (in defineCommand's spec)
tab(command, { root, path }) {
  command.option("legacy", "Old flag", (add) => add("yes", ""));
}

// per app; `command(path)` only accepts route paths of the tree
createApp(sv, {
  tab({ root, command }) {
    command("/img/web").options.get("format")!.handler = (add) => add("webp", "");
  },
});
```

`app.tab()` returns a fresh native `RootCommand` tree for inspection. `app.complete(words)` answers a request in-process, which is handy in tests.

Completion handlers must be synchronous and side-effect free. Completion requests never parse with Router, never build the context, never run checkpoint drivers, and never call command handlers.

### Advanced Router features

All Router elements work inside definitions: `transform()`, `extend()`, `cli()`, `env()`, `multiple()`, `checkpoint()`, `dynamic()`.

- **`checkpoint()` / `dynamic()`**: `createApp` requires a typed driver (it won't compile without one). The driver narrows `step.route`, does the I/O, and returns `step.resume(...)`. It also runs before help/version, because Router needs the full route graph. Handlers for routes created inside `dynamic()` work as usual. Completion only knows statically declared routes.
- **Value and env sources** are off by default. Router derives env names from route path plus parameter name, so a root option `path` would read `$PATH`. Opt in explicitly with `createApp(sv, { sources: (base) => ({ envs: [{ name: "env", value: base.env }] }) })`.
- **Bypassing the kit**: `app.parse(argv)` returns Router's own typed result (checkpoints driven, nothing printed or run), and `app.execute(intent)` dispatches one.

## Testing commands

```ts
import { runApp } from "../test/support/io.ts";
const { code, stdout, stderr } = await runApp(app, ["img", "web", "cat.png"]);
expect(app.complete(["img", "web", "--format", ""]).candidates).toEqual([...]);
```

- `test/app.test.ts`: dispatch, models, scoping, help/version/errors, context, checkpoints, validation
- `test/tab.test.ts`: the generated native Tab tree and completion requests through Tab's real parser
- `test/router-meta.test.ts`: the Router internals the kit relies on, pinned against the installed version
- `test/scripts.test.ts`: exact bash and zsh script fixes, plus shell syntax checks when available
- `test/shell.test.ts`: generated scripts driven by real zsh and bash when available
- `test/cli.test.ts`: the real `sv` executable as a subprocess
- `test/types/*.ts`: compile-time tests (`expectTypeOf`, `@ts-expect-error`), run by `bun check`

## Layout

```
src/
  main.ts            executable entry (process wiring only)
  app.ts             composition root: the `sv` tree and createApp()
  options.ts         root options (importable as an ancestor)
  context.ts         AppContext and its factory
  commands/          one module per command; groups are folders
  lib/               filesystem, media, text and blog operations
  kit/               the Router + Tab integration (see docs/architecture.md)
test/
```

## Reusable product APIs

Inspect, doctor and init JSON envelopes include `command` and `schemaVersion: 1`. Inspect's `result.kind` discriminates `image`, `video`, `markdown`, `other`, `directory`, `project`, `blog` and `error`; media metadata uses `status: "available" | "unavailable"`. Suggestions include argv arrays (without the executable) and shell-quoted display commands. Init's `status` is `planned`, `created`, `existing` or `declined`; declining exits 1. Doctor includes `ok` and checks with `ok`, `warning` or `error` status. Reusable APIs live in `src/lib/project.ts` (`discoverProject`, `loadProjectConfig`, `ProjectConfigSchema`) and `src/lib/inspect.ts` (`inspectPath(path, { cwd, env, signal? })`).

`src/lib/operations.ts` exports `FileOperation` (`create` or `replace`), `executeFilePlan(plan, { cwd, env, signal?, projectRoot?, stateRoot? })`, `readHistory`, `getReceipt`, `undoOperation` and `contentHash`. Replacements require `expected` original bytes or a SHA-256 hash, and preserve original permissions. Optional input fingerprints protect source-dependent outputs. Duplicate/overlapping destinations and conflicts with other operations' inputs are rejected before content or state writes. `stateRoot` injects an exact sv state directory for tests/embedders; `projectRoot` permits future callers to share identity explicitly. Preflight errors throw; application errors return a durable `partial` receipt that callers must check.

`readClipboard({ env?, signal?, maxBytes?, timeoutMs?, platform?, find?, run? })` in `src/lib/clipboard.ts` returns a discriminated `text`/`image` payload with bytes and MIME type, plus decoded text or PNG dimensions. `ClipboardError.code` distinguishes unavailable readers, desktop access, cancellation, timeout, byte limits, unsupported formats and invalid PNG data. Defaults are 16 MiB and a 3-second process deadline shared across negotiation and reading; listings are capped at 64 KiB. PNG validation also decodes with a 16 million pixel limit and checks cancellation afterward (native image decoding is not instantly interruptible). The injectable finder/byte runner supports isolated tests; runners must honor their supplied signal and limit. Copying also supports a deadline and cancellation; its default deadline is three seconds. Existing two-argument callers retain best-effort boolean results.

Ready provides `inspectReady`, `planReady` and `applyReady` in `src/lib/ready.ts`. Discovery, snapshots, encoding and application are separate phases; preview is not allowed to write outputs or history. Sharing uses a fixed manifest allowlist and the existing tunnel process lifecycle. The [architecture document](architecture.md) records the implementation boundaries.

Progress callbacks are optional `onProgress(ProgressEvent)` functions. Libraries report phases; `createProgressReporter` in `src/lib/progress.ts` handles TTY-only rendering, elapsed time and clearing on completion/cancellation. JSON and redirected output must disable transient rendering. `openLocalFile` in `src/lib/open.ts` is opt-in, accepts local regular files only, launches fixed argv without a shell, and bounds the opener process lifetime. Tests must use fake openers.

Ready reuse is receipt-backed via optional `recipeHash` fields, preserving schema-v1 compatibility. Update the image recipe revision when transformation semantics change, and the review recipe revision when generated report semantics change. A recipe match is only a candidate: current output bytes and recorded input identity must match, and application revalidates reused dependencies before writing. Tests must cover undo/modified output invalidation, read-only preview, changed settings and encoder identity.
