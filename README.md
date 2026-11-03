# sv

A personal CLI toolkit on [Bun](https://bun.com), [`@bomb.sh/router`](https://bomb.sh/docs/router/) and [`@bomb.sh/tab`](https://bomb.sh/docs/tab/).

`src/kit/` is a thin integration layer. Commands are native Router definitions. The kit attaches handlers, checks the composed tree at compile time, runs it, and generates Tab shell completion from the same definitions. It never hides either library: Router intents, models and printers, and Tab's native command objects, all stay reachable.

```bash
bun install
bun run sv media web cat.png --format avif   # run from source
bun link && sv --help                        # or put `sv` on your PATH
```

| Task                      | Command                       |
| ------------------------- | ----------------------------- |
| Tests (runtime + shells)  | `bun test`                    |
| Types (incl. type tests)  | `bun check`                   |
| Lint                      | `bun lint`                    |
| Format / check formatting | `bun fmt` / `bun fmt --check` |
| Everything CI runs        | `bun run verify`              |

`check`, `lint` and `fmt` are Bun's built-in tools. The exact Bun version for them is pinned as a dev dependency (`bun lint` is still canary-only), so `bun check`, `bun lint` and `bun fmt` run the same toolchain on any machine once `bun install` has run.

## Shell completion

```bash
# zsh (needs compinit)
echo 'source <(sv complete zsh)' >> ~/.zshrc
# bash (needs bash >= 4 and bash-completion; on macOS: brew install bash bash-completion@2)
echo 'source <(sv complete bash)' >> ~/.bashrc
```

The scripts run `sv` by name, so `sv` must be on your `PATH` (`bun link`). To try completion without installing, define a function in the current shell first: `sv() { bun /path/to/tools/src/main.ts "$@"; }`. To see what the shell sees, run `sv complete -- media web --format ""`.

## Adding a command

1. **Define it with Router and attach a handler.** Everything in `command(...)` is plain `@bomb.sh/router`, and the handler's input is inferred from it.

   ```ts
   // src/commands/media/thumb.ts
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

To read parent options, export a bundle from its own module, declare `inherit: { media: mediaOptions }`, and read `media` from the handler’s third argument.

2. **Mount it** inside its group, which is again plain Router: `route(name("media"), mediaOptions, web, inspect, thumb)`.

3. **Run `bun check && bun test`.** If the command can't work where you mounted it, `bun check` fails at `createApp(...)` in `src/app.ts` and names the route. That covers a missing handler, an inherited bundle without an applier, missing context services, duplicate names, a widened route type, and a missing checkpoint driver.

There is nothing else to register: dispatch, help, and completion all come from the definition.

### Groups and nesting

| You want                              | Write                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| A group that only contains commands   | `route(name("media"), ...children)`; bare `sv media` prints its help            |
| A command that also has subcommands   | `defineCommand(command(name("dev"), ...options, ...children), { run })`         |
| An executable root (`sv` alone)       | `defineCommand(command(name("sv"), ...), { run })`                              |
| A reusable bundle of options/children | `extend(...)` (Router)                                                          |
| Children from a module, as a list     | `export const commands = [a, b] as const`, then `route(name("x"), ...commands)` |

Keep child lists as tuples. A plain `AnyRoute[]` throws away every path and model type, and `createApp` rejects it.

### Parent options: `inherit`

Router scopes every option to the route that declares it. A command declares the option bundles it reads under local aliases; the handler receives their typed models as its third argument:

```ts
// src/commands/media/options.ts — its own module, so children can import it
export const mediaOptions = extend(option(name("quality"), schema(z.number().int().default(80))));

// src/commands/media/web.ts
export const web = defineCommand(
  command(name("web"), option(name("quality"), schema(z.number().optional()))),
  {
    inherit: { media: mediaOptions },
    run({ model }, _context, { media }) {
      const quality = model.quality ?? media.quality; // number | undefined, then number
    },
  },
);
```

`createApp` checks that a route on the mount path provides a compatible model. Runtime validation requires the exact bundle, by parameter identity. A different bundle with the same shape passes the type check but fails runtime validation. The nearest route applying the bundle wins, including the command itself and root. Namespaces stay separate: `media.quality` and `model.quality` above.

Commands no longer depend on mount paths: moving a group does not break its children, and handlers do not index models by path strings. Keep parent bundles in their own module to avoid circular imports.

**Option position follows Router.** Parent options go before the child's name:

```bash
sv --verbose media --quality 40 web cat.png    # ok
sv media web cat.png --verbose                 # error: unexpected `--verbose`
                                               # hint: --verbose is an option of `sv`; put it before `media`
```

This was a deliberate choice; see [docs/architecture.md](docs/architecture.md#option-position).

### Application context

Handlers get a second argument: the context. By default it's `BaseContext` (`program`, `stdout`, `stderr`, `env`, `cwd`, `signal`), and tests replace these through `app.run(argv, { stdout, env, cwd, ... })`. Application services live in `src/context.ts`. A handler that needs them annotates the parameter:

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
    command("/media/web").options.get("format")!.handler = (add) => add("webp", "");
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
const { code, stdout, stderr } = await runApp(app, ["media", "web", "cat.png"]);
expect(app.complete(["media", "web", "--format", ""]).candidates).toEqual([...]);
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
  kit/               the Router + Tab integration (see docs/architecture.md)
test/
```
