# sv

A personal CLI toolkit on [Bun](https://bun.com), [`@bomb.sh/router`](https://bomb.sh/docs/router/) and [`@bomb.sh/tab`](https://bomb.sh/docs/tab/).

`src/kit/` is the integration layer for parsing, execution, type verification and shell completion. Commands are native Router definitions. The kit attaches handlers, checks the composed tree at compile time, runs it, and generates Tab shell completion from the same definitions. It never hides either library: Router intents, models and printers, and Tab's native command objects, all stay reachable.

```bash
bun install
bun run sv img web cat.png --format avif    # run from source
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

The scripts run `sv` by name, so `sv` must be on your `PATH` (`bun link`). To try completion without installing, define a function in the current shell first: `sv() { bun /path/to/tools/src/main.ts "$@"; }`. To see what the shell sees, run `sv complete -- img web --format ""`.

## Commands

| Group      | Commands                                         | Purpose                                                               |
| ---------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| `paste`    | —                                                | Private clipboard summary and explicit safe save                      |
| `inspect`  | —                                                | Read-only file metadata and bounded directory summaries               |
| `doctor`   | —                                                | Check runtime, optional tools and project config                      |
| `init`     | —                                                | Preview and create a minimal project config                           |
| `img`      | `web`, `og`, `resize`, `compare`, `info`, `tune` | Image conversion, covers, resizing, diffs, metadata and visual tuning |
| `blog`     | `check`, `prepare`                               | Validate and safely prepare Markdown/MDX posts                        |
| `video`    | `webm`                                           | Convert video to WebM/VP9                                             |
| `gremlins` | —                                                | Find and fix invisible or suspicious Unicode                          |
| `share`    | —                                                | Deliberate local static/service sharing; optional public Quick Tunnel |
| `tunnel`   | —                                                | Expose a local port through a Cloudflare Quick Tunnel                 |
| `jwt`      | `decode`, `sign`, `verify`                       | Inspect and work with JSON Web Tokens                                 |
| `dev`      | `echo`                                           | Small development helpers                                             |

Every command has `--help` with its options, `--json` where structured output helps, and predictable exit codes: `0` success, `1` runtime failure, `2` usage error. Destructive actions are opt-in and previewed first.

### Inspect and project setup

```bash
sv inspect cover.png --json
sv inspect posts/                 # sample at most 200 immediate entries
sv doctor --json                  # optional tools missing: warnings, exit 0
sv init --dry-run --json          # preview only
sv init --yes                     # atomically create; never overwrite
```

`inspect` reads local files without writing, accessing the network or calling a model. It classifies images, videos, Markdown/MDX, blog/project directories and other files, and suggests commands without running them. Images reuse `img info` metadata; videos reuse ffprobe with local file protocols only. Missing ffprobe or unreadable media metadata produces an actionable `metadata.status: "unavailable"` with the remaining inspection intact. Missing paths, rejected symlinks and invalid relevant project configs exit 1. Directory inspection never recurses: it examines at most 200 immediate entries, excludes hidden entries, generated/vendor directories and symlinks, and reports truncation. Counts describe the sample, not the full tree. Markdown title detection reads at most 64 KiB and looks for an ATX H1.

Project discovery walks from the requested directory (or a file's parent) through ancestors. The nearest directory containing a marker wins. At that directory the precedence is `sv.config.json`, `sv.blog.json`, `.sv/blog.json`, `blog.config.json`, `.git`, then `package.json`. Both the sv config and the first blog config at the selected root are validated; malformed configs fail rather than silently falling back. Symbolic link paths/configs are refused.

`init` targets the discovered project root, or the current directory when no marker exists. It previews the exact path and contents on stderr, then confirms interactively or requires `--yes` for noninteractive/JSON creation. `--dry-run` always previews without writing. Existing sv or blog configuration is reported unchanged. Version 1 is deliberately minimal:

```json
{ "schemaVersion": 1 }
```

Extra fields and unsupported versions are rejected. Blog behavior continues to use its existing blog config. `doctor` checks Bun >=1.4.0, presence of ffmpeg, ffprobe, cloudflared and a clipboard binary, plus selected project config validity. Optional missing tools warn with setup advice; invalid config/runtime exits 1. It never installs anything, executes the optional binaries or prints environment values. Binary presence does not guarantee desktop clipboard access or codec support.

JSON envelopes include `command` and `schemaVersion: 1`. Inspect's `result.kind` discriminates `image`, `video`, `markdown`, `other`, `directory`, `project`, `blog` and `error`; media metadata uses `status: "available" | "unavailable"`. Suggestions include argv arrays (without the executable) and shell-quoted display commands. Init's `status` is `planned`, `created`, `existing` or `declined`; declining exits 1. Doctor includes `ok` and checks with `ok`, `warning` or `error` status. Reusable APIs live in `src/lib/project.ts` (`discoverProject`, `loadProjectConfig`, `ProjectConfigSchema`) and `src/lib/inspect.ts` (`inspectPath(path, { cwd, env, signal? })`).

### Images

```bash
# Convert a batch to WebP, capped at 1600px wide, without overwriting anything.
sv img web posts/ --width 1600 --quality 82

# Optimize OpenGraph covers. PNG stays PNG unless --format says otherwise.
sv img og covers/*.png --target 1200x630 --strict

# Resize with aspect-ratio-aware fitting. Upscaling is off by default.
sv img resize hero.jpg --width 1280 --fit cover

# Compare two builds; exit 1 when more than 0.5% of pixels differ.
sv img compare before.png after.png --max-diff 0.5

# Inspect dimensions, format, size and animation metadata.
sv img info cover.png hero.jpg
```

Existing outputs are never replaced unless you pass `--force`; otherwise the tool picks `name-1.webp`, `name-2.webp`, and so on. Batch destinations are reserved during planning, so dry runs handle colliding filenames consistently. If an output appears after planning, writing fails instead of replacing it. `--dry-run` performs the transform to report sizes but writes no files. Originals are preserved by default; `--force` can replace an original when it is also the output path.

`img web` preserves existing target-format bytes when resizing is unnecessary. Pass `--reencode` or an explicit `--quality` to recompress them. `--force` controls replacement, independently of recompression. `img og` preserves PNG pixel values by default; `--palette` explicitly enables palette quantization.

`sv img tune hero.jpg --width 1600 --qualities 60,75,85 --format webp --out review.html` exports one self-contained offline HTML review. Select quality, drag the comparison divider, zoom to output pixels and scroll to pan both images together. Download the selected encoded image from the report. `--json` prints the report path and variant metadata; no browser opens and no separate variant files are written. Existing report names receive a numeric suffix, including explicit `--out`; there is no overwrite option.

Tune defaults to WebP, width 1600 and qualities 60,75,85, never upscales, applies orientation, and strips metadata. The original reference is a lossless PNG at the output dimensions; byte savings compare each encoding with the source file. Only the filename and relevant dimensions/settings are included. V1 accepts static raster images supported by Sharp, rejects SVG and animation/multiple pages, and caps inputs at 12 MiB/24 megapixels, width at 2560, distinct qualities at five, and total embedded image bytes at 20 MiB (roughly 27 MiB HTML). Reduce width or variant count if the report budget is exceeded. AVIF is optional and slower. Source files are preserved.

### Blog

`blog` is layout-agnostic. Point it at a project root and describe the layout in `sv.blog.json` (or `.sv/blog.json`, or `blog.config.json`). See [`examples/ens-blog/sv.blog.json`](examples/ens-blog/sv.blog.json) for a complete example.

```bash
sv blog check posts/ --strict
sv blog prepare posts/ --dry-run
sv blog prepare posts/ --yes
```

`check` validates metadata, local links and media, alt text, slugs, oversized assets, Notion export artifacts, tracking parameters and Unicode. `prepare` previews every edit before writing, removes Notion artifacts, strips tracking parameters, replaces invisible characters, normalizes blank lines, and rewrites referenced images. Deletion requires `prepare.deleteOriginals: true` (or `--delete-originals`). Even then, shared/public assets and originals with possible remaining references are preserved. Cleanup protects code, frontmatter and MDX expressions; ambiguous URL source syntax is left unchanged. Functional query parameters such as `s`, `source` and `ref` are preserved.

Preparation shares image plans across posts and checks input fingerprints before applying changes. Entries are updated sequentially; originals are considered for deletion only after all entries succeed. Individual writes are atomic, but the batch has no rollback: failures report completed writes for recovery. Encoded image data is held once per unique asset until application. JSON output requires `--yes` to apply (`--dry-run --json` previews without approval). It never publishes or opens a pull request.

Minimal config:

```json
{
  "name": "My blog",
  "postsDir": "posts",
  "entries": ["index.md", "index.mdx"],
  "metadataFiles": ["meta.json"],
  "requiredMetadata": ["title", "slug"],
  "slugField": "slug",
  "prepare": {
    "imageFormat": "webp",
    "imageWidth": 1600,
    "imageQuality": 82
  }
}
```

### Unicode gremlins

```bash
sv gremlins src/                       # scan, respecting .gitignore
sv gremlins docs/ --min-severity warn  # only show warnings and errors
sv gremlins docs/ --fix --dry-run      # preview safe replacements
sv gremlins docs/ --fix --yes          # apply, preserving encoding and line endings
```

Scanning and fixing are separate. `--fix` previews first, asks for confirmation on a TTY, and refuses to overwrite a file that changed after the scan. Typography replacements (curly quotes, en dashes) require `--fix-typography`. Missing targets and scan errors produce a failure exit status. Binary/non-UTF-8 files and files above `--max-bytes` are intentionally skipped and reported. Dry runs report findings as remaining and exit nonzero while findings exist. Replacement preserves file permissions. Explicit `gremlins --fix` applies across the selected file, including literal strings; review the preview when changing source code.

### Share

```bash
sv share ./site --dry-run --json   # read-only manifest; no listener or tunnel
sv share ./site --yes              # 127.0.0.1, automatically selected port
sv share 3000 --yes --timeout 30m   # point to an existing loopback HTTP service
sv share 'http://[::1]:8080/' --public --yes --json
sv share ./site --public --copy    # confirm exact exposure, then copy the URL
```

`share` previews the exact target and static file manifest on stderr before asking to start. `--yes` approves noninteractive starts; JSON starts require it. `--preview` aliases `--dry-run`: both only inspect, even with `--public`, `--copy` or `--yes`. Local mode needs no optional binaries, opens no browser, and publishes nothing. Existing service targets are parsed without DNS lookup or HTTP requests: only HTTP(S), no credentials/fragments, ports 1–65535, and exact `localhost`, canonical IPv4 in 127/8, or IPv6 `[::1]`. A bare port selects `http://127.0.0.1:PORT/`. The service owns its responses, redirects and routes; sharing a URL path does not restrict public access to that path.

Static sessions bind only `127.0.0.1`; `--port 0` (default) chooses a free port. Inspection fails above 5,000 traversed entries, 1,000 files, 100 MiB total or 16 nested directory levels. Dotfiles (including `.env` and `.git`), symlinks and `node_modules`, `vendor`, `dist`, `build`, `coverage`, `target`, `out` directories are skipped. Use an explicit static output directory as the target to share its contents. Symlinks in the selected path or its ancestors are refused. The manifest is fixed for the session: new files are unavailable, and edited/replaced files require restarting. Every read checks path components, opens without following a final symlink and verifies the file identity before and after a bounded read. GET and HEAD are supported with MIME types; a small escaped file listing is generated at `/` when there is no root `index.html`. No custom routes or script callbacks run in the server.

`--public` explicitly starts the existing `cloudflared` Quick Tunnel lifecycle after approval; anyone with the link can access the selected static files or the entire existing service. Missing `cloudflared` reports installation guidance. No account, domain or persistent configuration is created. `--json` emits one `{command:"share", schemaVersion:1, event:"ready", url, mode, target}` event as soon as the local listener or public URL is ready, then stays alive. Plans and diagnostics remain on stderr. `--timeout` accepts `ms`, `s`, `m`, `h` (for example `30s` or `1.5h`); expiry and Ctrl+C stop the owned listener/tunnel. An existing service remains running. `--copy` calls the existing best-effort clipboard API only after readiness. QR codes, authentication and a dashboard are deferred.

### Tunnel

```bash
sv tunnel 3000
sv tunnel 8080 --host 127.0.0.1 --copy
```

`tunnel` prints an exposure warning, starts a Cloudflare Quick Tunnel with `cloudflared`, prints the public URL, and cleans up the child process on Ctrl+C. It does not require a Cloudflare account. Quick Tunnel URLs are temporary and public; do not expose sensitive services. `--json` emits the URL as soon as the tunnel is ready and keeps running until stopped.

### Video

```bash
sv video webm clip.mp4 --width 1920 --crf 32
sv video webm recordings/ --audio strip --dry-run
```

`video` requires `ffmpeg` and `ffprobe` on `PATH`. It preserves the aspect ratio, never upscales, keeps audio as Opus unless `--audio strip` is set, and removes partial output files if encoding fails.

### JWT

```bash
# Decode without a secret; this never verifies the signature.
sv jwt decode "$TOKEN" --json

# Secrets come from the environment, a file, or stdin — never argv.
export JWT_SECRET='...'
sv jwt sign --payload '{"sub":"user-1"}' --secret-env JWT_SECRET --expires-in 1h
sv jwt verify "$TOKEN" --alg HS256 --secret-env JWT_SECRET --issuer my-app
```

`verify` requires `--alg` so a token cannot choose its own algorithm. `decode` reports `verified: false`; use `verify` when the signature matters. `--json` is available on all three commands.

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
sv --verbose img --quality 40 web cat.png      # ok
sv img web cat.png --verbose                   # error: unexpected `--verbose`
                                               # hint: --verbose is an option of `sv`; put it before `img`
```

This was a deliberate choice; see [docs/architecture.md](docs/architecture.md#option-position).

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

### File operation history and undo

```bash
sv img web photo.png --record --json  # includes recordId; preserves the input
sv history                           # receipts for this canonical cwd
sv history <id> --json
sv undo last --dry-run --json         # validates every output, input and backup
sv undo <id> --yes                    # delete created files; restore replacements
sv undo <id> --yes --json             # JSON application always requires --yes
```

Recording is opt-in because replacement backups retain original file contents and receipts retain explicit file paths. Only `img web --record` uses this foundation today. It plans the whole batch before writing, reports the receipt id on stderr and in JSON, and leaves originals in place. Recorded conversion refuses an output equal to its source; choose a separate output. `--force --record` can replace a separate existing target and back it up. Dry runs and skipped conversions create no history. Other commands, including JWT and clipboard workflows, do not record anything.

Version 1 receipts live under `$XDG_STATE_HOME/sv`, or `$HOME/.local/state/sv` (OS home fallback), partitioned by the SHA-256 of the canonical cwd. Running in a different directory selects different history; no project discovery is performed. State directories use mode 0700; backups and receipts use 0600. Created outputs are not duplicated in state. Only replacement originals are backed up. Receipts contain explicit operations, hashes, modes, timestamps and application/undo status; they never capture argv, environment or stdin. History reads and undo previews do not create state directories. There is no automatic retention policy yet.

Undo previews before asking for confirmation. Noninteractive application requires `--yes`; `--dry-run` validates without mutation. Undo refuses the whole plan when an output or source changed, or a replacement backup is corrupt. It never recursively removes directories. Individual publications are atomic; multi-file plans and undo are **not transactions**. Cancellation or runtime failure retains a `partial` receipt with per-file progress. A crash during publication may leave `applying`; undo checks the actual bytes before proceeding. An interrupted `undoing` file requires manual inspection. The per-project lock serializes writers, waits up to two seconds, and fails closed on a stale lock; inspect the operation and remove the reported lock only when no writer is active. As with existing safe file writes, validation and publication have a small filesystem race window against unrelated concurrent writers; this is not an adversarial filesystem isolation mechanism.

For future callers, `src/lib/operations.ts` exports `FileOperation` (`create` or `replace`), `executeFilePlan(plan, { cwd, env, signal?, projectRoot?, stateRoot? })`, `readHistory`, `getReceipt`, `undoOperation` and `contentHash`. Replacements require `expected` original bytes or a SHA-256 hash, and preserve original permissions. Optional input fingerprints protect source-dependent outputs. Duplicate/overlapping destinations and conflicts with other operations' inputs are rejected before content or state writes. `stateRoot` injects an exact sv state directory for tests/embedders; `projectRoot` permits future callers to share identity explicitly. Preflight errors throw; application errors return a durable `partial` receipt that callers must check.

### Clipboard input

```bash
sv paste --json                        # metadata only; no clipboard text is printed
sv paste --out clipboard.png --yes     # save PNG bytes without overwriting
sv --cwd ./notes paste --out clip.txt --yes --json
```

`paste` explicitly reads the clipboard and classifies PNG images, JWT-shaped text, readable path lists (up to 256 entries), HTTP(S) URLs and generic text. Summaries omit clipboard text, paths, URL contents and tokens; suggested commands use placeholders. JWT detection does not decode or verify a token. Path classification checks local readability only and never executes a path or follows a URL over the network. No models, history receipts or backups are involved.

`--out` previews the absolute destination on stderr and asks for confirmation. Noninteractive saves and JSON saves require `--yes`. Saves preserve the exact selected bytes, leave the clipboard intact, use private file permissions (0600), and atomically refuse an existing destination, including symlinks. PNG output must end in `.png`; text cannot be saved under a known image extension. There is no implicit conversion. Read-only summaries write no files.

Readers use available native tools: `pbpaste` on macOS (text only), `wl-paste` on Wayland (preferred in a Wayland session), `xclip` on X11 (text/PNG), `xsel` (text only), or `powershell.exe` on Windows/WSL (text only). No GUI package is required by sv. Missing tools and failed desktop access produce actionable errors. PNG is preferred over a text representation when advertised; other advertised image formats are explicitly unsupported. Empty/text-incompatible selections on text-only backends are rejected; use a PNG-capable reader for image input. No clipboard data is interpolated into shell commands or child diagnostics.

For future consumers, `readClipboard({ env?, signal?, maxBytes?, timeoutMs?, platform?, find?, run? })` in `src/lib/clipboard.ts` returns a discriminated `text`/`image` payload with bytes and MIME type, plus decoded text or PNG dimensions. `ClipboardError.code` distinguishes unavailable readers, desktop access, cancellation, timeout, byte limits, unsupported formats and invalid PNG data. Defaults are 16 MiB and a 3-second process deadline shared across negotiation and reading; listings are capped at 64 KiB. PNG validation also decodes with a 16 million pixel limit and checks cancellation afterward (native image decoding is not instantly interruptible). The injectable finder/byte runner supports isolated tests; runners must honor their supplied signal and limit. Existing `copyToClipboard()` callers are unchanged.

### Ready: preview a preparation batch

```bash
sv ready posts/ images/                  # preview only; no files, reports or history written
sv ready . --changed --json              # staged, unstaged and untracked files in Git
sv ready images/ --out-dir sv-ready --review --apply  # full preview, then confirmation
sv ready images/ --width 1280 --quality 75 --format webp --yes --json
sv undo <recordId> --yes                 # remove the newly created outputs
```

`ready` recursively selects local content with deterministic ordering. The default is preview;
`--dry-run` explicitly requests that behavior and takes precedence over application flags.
`--apply` confirms after the full preview; `--yes` authorizes application directly.
JSON application requires `--yes`. A clean changed selection is a successful no-op.
Use root options before the command, for example `sv --cwd my-project ready . --changed`.

V1 creates optimized **new static raster images**, preserving originals. Defaults are WebP,
1600px maximum width (no enlargement), quality 82. AVIF is also supported. Existing target-format
images within the width are skipped unless `--quality` or `--review` is explicit. Animation,
multiple pages, SVG and unknown file types are reported as unsupported. Video is inspected and
gets a suggested `video webm` command; it is never converted by `ready`. Markdown/MDX uses the
existing blog checks for metadata, links, media and Unicode, with suggested separate commands.
Checks can report unresolved content issues even when image application succeeds; ready does
not rewrite posts, fix links or promise that every issue is handled. Blog checks run per selected
post, so this increment does not check duplicate slugs across the whole project.

Outputs default to `.sv-ready/` under the command's cwd. Prefer an explicit dedicated `--out-dir`.
Existing destinations receive numeric suffixes; the whole batch reserves names, including
colliding basenames from different directories. Default generated directories (`.sv-ready` and
`sv-ready`), the current output directory, history, hidden descendants and vendor/build directories
are excluded. Reuse the same explicit output directory on later runs to exclude custom outputs.
`--review` plans one existing offline image-review HTML per applied image, containing the chosen
encoding and a lossless resized reference. Preview emits no report. All outputs, including
reports, are recorded together through the existing file-plan executor; the result exposes
`recordId` for `history` and `undo`. Undo removes files, leaving any empty output directories.

Planning failures (missing/unreadable inputs, broken media, invalid selected project config or
exceeded budgets) block the entire application. Source fingerprints come from the exact in-memory
snapshots used for encoding; changed sources are rejected before writes. Publication is atomic
per file, not a multi-file transaction: a later race or I/O failure can return a partial receipt
for inspection/recovery. `ready` never replaces or deletes sources.

Budgets are intentionally fixed: 200 selected files, 1000 traversed entries, 12 MiB per image or
Markdown input, 24 megapixels per image, width at most 2560, 64 MiB total image snapshots and
64 MiB total encoded outputs (including HTML). Reviews additionally cap embedded images at
20 MiB each. Snapshots and encoded outputs stay in memory until application; decoding uses
additional memory. Narrow targets or reduce width when a budget is exceeded. Blog checks also
read referenced local metadata/media through their existing APIs.

`--changed` uses NUL-delimited Git argv calls without shell evaluation. It unions staged,
unstaged and untracked paths, supports unborn HEAD and filenames containing spaces/newlines,
and scopes changes to the supplied files/directories (default cwd). Deleted files are listed as
skipped; unknown targets and use outside Git are errors. It does not implement watch, presets,
model-based fixes, uploads or publishing.
