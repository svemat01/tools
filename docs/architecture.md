# Architecture

`src/kit/` makes `@bomb.sh/router` 0.8 and `@bomb.sh/tab` 0.0.22 work as one CLI without wrapping either. Router owns definitions, parsing, models, help and errors. Tab owns completion parsing and shell scripts. The kit adds:

| Concern                       | Module           | Size of the idea                                               |
| ----------------------------- | ---------------- | -------------------------------------------------------------- |
| Handlers on routes            | `command.ts`     | `defineCommand(route, spec)` stores `spec` on the route object |
| Tree verification (types)     | `verify.ts`      | Assignability of Router's real intents to handler inputs       |
| Running                       | `app.ts`         | parse → drive checkpoints → print or dispatch                  |
| Completion metadata on params | `complete.ts`    | One Router param element                                       |
| Router introspection          | `router-meta.ts` | The only reader of Router internals                            |
| Tab tree + requests           | `tab.ts`         | Router metadata → native Tab objects; directive fix            |
| Shell script fixes            | `scripts.ts`     | Four exact-snippet bash fixes                                  |

There's no plugin system, middleware, event bus, DI container or renderer. Nothing in a command module is a kit concept except `defineCommand` and `complete`.

## Handlers: where inference happens

A handler needs three things typed: its own model, its ancestors' models, and the application context. The hard part is that a command module is written before it's mounted, so it can't know its ancestors.

Options considered:

1. **Handlers keyed by path at the app** (`createApp(root, { "/media/web": handler })`). This gives perfect types from Router's `IntentsOf`, but every command is registered twice (route and path) and handlers live away from their definitions.
2. **A handler as a Router element** (`command(name("x"), ..., run(fn))`). It's native-looking, but TypeScript can't contextually type `fn` from the elements before it in a variadic call, so the handler would be untyped.
3. **Implicit ancestor context.** A merged object of every ancestor's options. It flattens namespaces (collisions), and a module can't know what it'll get. It's either unsafe or needs global type registration.
4. **Declare bundles, resolve by identity, verify at createApp (chosen).** `defineCommand(command(...), { inherit, run })` infers the own model from the definition. Commands declare option bundles under local aliases (`inherit: { media: mediaOptions }`) and receive their typed models as the handler's third argument. Runtime resolution finds the nearest route on the invoked path that applied the exact bundle, by parameter identity. `createApp(root)` checks that a model on the mount path is assignable to each bundle's model and verifies the application context. A different bundle with the same shape passes the type check but fails runtime validation.

Option 4 keeps commands self-contained and preserves Router's per-route namespaces. Bundles decouple commands from mount paths: moving a group does not break its children, and handlers do not index by path strings. Missing or incompatible models fail at `createApp` with a message naming the path.

The handler receives Router's **actual intent object**. `intent.model`, `intent.models`, `intent.literals`, `intent.definition` and `intent.path` are all Router's, typed down to what the handler declared.

Unchecked widening happens in exactly two places, both in `app.ts`: calling the stored handler and calling the context factory. Both are justified by the `Verify` constraint on `createApp`. No command code casts.

`createApp` also rejects, at compile time: executable routes without handlers, duplicate sibling names, the reserved root name `complete`, route types widened to `AnyRoute` (for example `AnyRoute[]` spreads), and trees with `checkpoint()`/`dynamic()` but no typed driver. The same checks run at runtime (`validate()`) for trees built dynamically or with types bypassed, plus checks the types can't see: flags Router reserves (`-h --help -v --version`), a flag bound by two parameters, arguments after a variadic, and malformed route names.

### Application context

The context is a separate channel from models. `BaseContext` holds process facilities (`stdout`, `stderr`, `env`, `cwd`, `signal`, `program`), all overridable per `run()` for tests. Application services come from `createApp(root, { context(base, intent) })`, which runs once per executed command and never for help, errors or completion. Its required return type is the intersection of every handler's declared context (`ContextOf<R>`), so it can't under-provide. It receives the execute intent, so configuration such as a root `--verbose` can shape services (see `src/context.ts`) without dumping models into the context.

## Option position

Router binds each option to the route segment it appears in: tokens before a child's name belong to the parent, tokens after belong to the child. The kit keeps this:

```bash
sv --verbose media web x.png    # ok
sv media web x.png --verbose    # unexpected `--verbose` (with a hint naming where it belongs)
```

Reasons:

- It makes same-named options at different levels unambiguous (`sv media --quality 40 web --quality 90`). Global flags "after the leaf" would have to steal tokens from the child, which is ambiguous exactly when the child declares the same name.
- Reordering argv before Router sees it would also have to understand option values, `--name=value`, `--` and custom `cli()` readers, which is a second parser that can disagree with Router.
- Tab completes flags for the matched command only, which is the same model.

The usability cost is softened by the error hint (`hint: --verbose is an option of \`sv\`; put it before \`media\``). If a truly global flag is ever needed, the principled alternative is an environment variable through `createApp({ sources })`, not argv rewriting.

## Router integration points

Router has no documented introspection API. `router-meta.ts` reads `route.{name, description, methods, version, phases[].routes, phases[].model.params, phases[].resolver}` and `param.{name, description, cardinality, cli}`.

Flag names aren't data in Router: a parameter has an opaque `cli.read(tokens)` and a human label. The kit uses the label and Router's naming rule (`--kebab-name`, `--no-kebab-name`) as _candidates_, then probes the real reader with synthetic tokens to keep only flags it actually claims, and to learn whether each consumes a value. A misleading or missing label therefore can't produce wrong completions.

Runtime contracts the kit relies on, all pinned in `test/router-meta.test.ts`:

- `intent.definition` is the mounted route object, so `defineCommand`'s symbol property is how dispatch finds the handler. No path registry. Dynamic continuations spread the paused route, so the property survives `dynamic()`.
- `-h/--help/-v/--version` are claimed anywhere before `--`.
- Children and parameters of later phases (after `checkpoint()`) are statically visible. Routes created by a `dynamic()` extension aren't, until `resume()`.

## Tab integration

For every static route the kit creates a native Tab command (`root.command("media web", description)`, Tab's convention for nesting) and registers:

| Router                                | Tab                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `option()` / `cli([...])` long flags  | `Option` per long flag; `isBoolean` from probing                         |
| first short flag (`-o`)               | `alias` of the primary option                                            |
| `toggle()`                            | boolean `--x` and `--no-x` (otherwise Tab thinks `--no-x` takes a value) |
| `argument()` / `multiple()`           | `Argument`, in declaration order, `variadic` for `multiple()`            |
| every route / routes with `version()` | boolean `--help`/`-h`, `--version`/`-v`                                  |
| `complete(...)` on the param          | the option/argument `handler`                                            |

Hooks then receive the native objects: `defineCommand({ tab(command, { root, path }) })` and `createApp({ tab({ root, command }) })`, where `command(path)` only accepts the tree's route paths. Completion customization has no name-based references at all: `complete()` sits on the parameter, so `cli()` renames and `transform()` reshapes can't desynchronize it.

**Isolation.** Every request builds a fresh `RootCommand`. Tab's default export is a process-global singleton and is never used. Tab prints with `console.log`, so the kit captures it for the duration of the synchronous `parse()` call and writes the result to the app's own `stdout`.

**No side effects.** A completion request only reads static metadata. It doesn't call Router's `parse`, the context factory, checkpoint drivers or handlers (tested with spies).

### What the kit adds to Tab's parser, and why

Tab's parser is used as-is. Three small things are added around it:

1. **Native path completion.** Tab always ends a response with `:4` (`NoFileComp`), so the shell never completes paths ([tab#97](https://github.com/bombshell-dev/tab/pull/97), closed unmerged). `files()`/`directories()` handlers record a request during Tab's parse, and the kit rewrites the directive of the documented protocol output: `0` (shell default: paths), `8` with extensions (`FilterFileExt`), or `16` (`FilterDirs`). Extension lines for `FilterFileExt` are printed bare, without a tab: zsh turns the tab into `:` and would glob `*.png:`. If real candidates exist (say, subcommands), they're kept with directive `0`, so paths are the fallback when none match.
2. **`--name=value` in earlier words** is split into `--name value` before Tab sees it. Tab resolves option arity by exact lookup, so `--quality=5` was unknown to it and swallowed the next word (the subcommand).
3. **After `--`**, Router binds nothing (only `intent.literals`), so the kit returns no candidates and lets the shell complete paths.

### Shell scripts

Fish and PowerShell scripts are Tab's unchanged. The bash script gets four exact-snippet fixes (`scripts.ts`; if Tab's text changes, generation throws rather than shipping a half-patched script):

1. `complete -o default -F`, so an empty reply falls back to bash's own path completion (`NoFileComp` still disables it via `compopt +o default`).
2. `FilterFileExt` built the glob `\.(|png)`, which matches nothing (verified) and also drops directories. It now uses bash-completion's `_filedir 'png|jpg'`.
3. `FilterDirs` word-split names with spaces. It now uses `_filedir -d`.
4. For `--opt=value`, candidates were matched against the whole `--opt=v` word. They're now matched against the value part, which is what readline replaces.

The zsh script gets three exact-snippet fixes:

1. `words` uses `(@)` instead of `=` to preserve words containing spaces.
2. Arguments are unquoted with `(Q)` before `(q)` quotes them for the request, preserving what the user meant and preventing typed `$(...)` from executing on TAB.
3. Colons are escaped with `\\:` so `_describe` keeps them in values.

Tab's bash script requires bash ≥ 4 and the bash-completion package (macOS ships bash 3.2). Real-shell tests run when the shell is available and skip with a reason otherwise. CI installs zsh and bash-completion.

## Upstream limitations

These are Tab's, not the kit's, and each is pinned or documented by tests:

- **Option arity is resolved root-first for the whole line** ([tab#153](https://github.com/bombshell-dev/tab/issues/153), fix in [tab#154](https://github.com/bombshell-dev/tab/pull/154)). If a parent's `--x` is boolean and a child's `--x` takes a value, the child's values aren't completed. Router itself handles this correctly. `test/tab.test.ts` pins the current behaviour so the upgrade is noticed.
- **No file completion in Tab's directive** ([tab#97](https://github.com/bombshell-dev/tab/pull/97)). The kit works around it with the protocol-level rewrite above. The small upstream improvement would be letting handlers set a per-request directive (or an `emitCompletions(completions, directive)` API, [tab#107](https://github.com/bombshell-dev/tab/issues/107) / [#124](https://github.com/bombshell-dev/tab/pull/124)). The rewrite could then be deleted.
- **bash and zsh script bugs** listed above. These are upstreamable as-is.
- **One alias per option.** A second short flag (`cli(["--out", "-o", "-O"])`) parses fine in Router but only the first is completed.
- **Positionals before a subcommand.** Router selects a child by the first word naming it, even after a parent positional. Tab only matches commands from the start. This only matters for routes with both positional arguments and children; avoid that shape.
- **Shell `eval`.** Tab's bash script still `eval`s typed words to build the request (the same design as cobra). Only zsh is fixed by the quoting change above.

## Unresolved trade-offs

- Parent option bundles must live in their own module to avoid circular imports. A bundle applied at several levels resolves to the nearest route, including the command itself.
- Completion of dynamically discovered routes (`dynamic()`) would need I/O during completion, which the kit deliberately never does. Use the app-level `tab` hook to add them from a cache if needed.
- Router decodes values before schemas see them (`007` → `7` first), so values that look like numbers need string schemas. That's Router behaviour, documented upstream.
- Version-sensitive code is isolated and tested, but Router and Tab are pre-1.0. Upgrade both deliberately, then run `bun run verify`.
