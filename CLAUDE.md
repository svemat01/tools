# Project guidance: `sv`

Use Bun for installation, execution, formatting, linting, types and tests.

A personal CLI built on `@bomb.sh/router` (commands, parsing, help) and `@bomb.sh/tab` (shell completion), glued together by the thin layer in `src/kit/`. Read `README.md` for the authoring API and `docs/architecture.md` for the design.

Adding a command:

1. Create `src/commands/<group>/<name>.ts` exporting `defineCommand(command(name("x"), ...routerElements), { run(intent, context) {...} })`. Use native Router elements; the handler's input is inferred, so do not write model interfaces.
2. To read a parent's options, export the parent's options as an `extend(...)` bundle in its own module and declare `inherit: { group: groupOptions }`. Read `group` from the handler’s third argument; never cast to reach `intent.models`.
3. To use app services, annotate the handler's second parameter as `AppContext` (from `src/context.ts`).
4. To add completion candidates, put `complete([...])`, `complete(files())`, `complete(directories())` or a native Tab handler on the parameter, next to `schema()`. Never derive candidates from schemas.
5. Mount it in its group (`route(...)`/`command(...)` children), then run `bun check && bun test`. A `"~sv problems"` type error at `createApp()` lists what is wrong, by route path.

Rules:

- Keep child route lists as tuples (`as const`); never type them as `AnyRoute[]`.
- `src/kit/router-meta.ts` is the only module allowed to read Router's runtime route/param internals; `src/kit/tab.ts` and `src/kit/scripts.ts` own Tab specifics. Version-sensitive behaviour is pinned in `test/router-meta.test.ts` and `test/scripts.test.ts`.
- Do not use Tab's default export (a global singleton); the kit builds a fresh `RootCommand` per request.
- Completion code paths must not parse with Router, build context, or call handlers.
- Run `bun run verify` (fmt check, lint, types, tests) before finishing.

File and content safety:

- New outputs use `writeFileAtomic()` without overwrite; replacement requires explicit `{ overwrite: true }`. User documents must also supply `expectedBytes` from the planning read.
- Display the change plan before confirming or applying it. Send prompts and human diagnostics to stderr when stdout is JSON.
- Blog preparation coordinates all selected posts through one prepare session; do not independently apply posts in parallel.
- Preserve code, frontmatter and MDX expressions during prose cleanup. Rewrite URLs only through exact source spans.
- Test command wiring as well as library helpers when adding or changing an option.
