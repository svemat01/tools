# sv

A personal command-line toolkit for inspecting files, preparing images and blog posts, reviewing changes, and sharing local work.

Preview a content batch with `ready`, reuse verified outputs on repeat runs, choose image quality in an offline comparison, and undo explicitly recorded outputs. Everything runs locally; public sharing starts only when requested.

## Start here

Requires [Bun](https://bun.com) 1.4 or newer. From this checkout:

```bash
bun install --frozen-lockfile
bun link
sv doctor
sv inspect .
```

Use `bun run sv ...` from the repository if you prefer not to link the executable. See [installation, optional tools and shell completion](docs/getting-started.md).

## Five useful things

```bash
sv ready ./images                         # preview; no outputs written
sv ready ./images --review --apply        # confirm, create images/reports, record undo history
sv img tune photo.jpg --open              # offline comparison; explicitly open the report
sv paste --json                           # clipboard metadata; no raw text/token output
sv share ./site --dry-run                 # inspect exactly which files would be served
```

Replace example paths with your own. `ready` currently applies static image outputs; it checks/suggests workflows for other content. Reported validation errors block application; warnings can still need attention. [Choose a workflow](docs/workflows.md).

## Commands

| Command                                              | Use it for                                                                           | Guide                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `ready`                                              | Preview/apply bounded image batches, optional review HTML, Git `--changed` selection | [Ready](docs/ready.md)                                       |
| `watch`                                              | Continuous read-only checks, changed-file selection and one-shot checks              | [Watch](docs/watch.md)                                       |
| `inspect`                                            | Read-only metadata and sampled directory summaries                                   | [Getting started](docs/getting-started.md)                   |
| `doctor`, `init`                                     | Check optional dependencies and create a minimal project marker                      | [Configuration](docs/configuration.md)                       |
| `img web`, `og`, `resize`, `compare`, `info`, `tune` | Convert, resize, inspect, compare and visually tune images                           | [Images](docs/images.md)                                     |
| `blog check`, `prepare`                              | Validate posts and preview/apply conservative cleanup                                | [Blog](docs/blog.md)                                         |
| `history`, `undo`                                    | Inspect or reverse recorded file operations                                          | [History](docs/history.md)                                   |
| `paste`                                              | Privately summarize or explicitly save clipboard input                               | [Clipboard](docs/clipboard.md)                               |
| `share`, `tunnel`                                    | Serve local files/services and optionally start a public Quick Tunnel                | [Sharing](docs/sharing.md)                                   |
| `port-forward`, `pf`                                 | Reach a remote TCP port over SSH                                                     | [SSH port forwarding](docs/sharing.md#ssh-port-forwarding)   |
| `video webm`                                         | Convert a recording with FFmpeg                                                      | [Workflows](docs/workflows.md#convert-a-recording)           |
| `gremlins`                                           | Find suspicious Unicode and preview replacements                                     | [Workflows](docs/workflows.md#find-suspicious-unicode)       |
| `jwt decode`, `sign`, `verify`                       | Inspect, create or verify JWTs with explicit key input                               | [Workflows](docs/workflows.md#inspect-or-verify-a-jwt)       |
| `dev`, `dev echo`                                    | Runtime information and small development helpers                                    | [Workflows](docs/workflows.md#small-development-helpers)     |
| `complete`                                           | Generate shell scripts or inspect completion protocol output                         | [Shell completion](docs/getting-started.md#shell-completion) |

[Command reference](docs/reference.md) lists the installed command tree and its native help. Every command has `--help`. Global options go before the command: `sv --cwd ./project ready . --changed`.

## Know what changes

- `ready` previews by default. `--apply` asks after the plan; `--yes` authorizes application.
- Existing outputs are preserved by default. Output naming and explicit replacement options are command-specific.
- Applied `ready` outputs and `img web --record` create local receipts. `sv undo` only covers recorded operations; it is not a universal rollback command.
- Clipboard summaries omit copied text, paths, URLs and tokens. Explicit saves use private permissions.
- Sharing defaults to loopback. `--public` deliberately exposes the selected files or service through Cloudflare.

Read each guide's limits before applying a large batch. Multi-file changes are not transactions. [Troubleshooting and recovery](docs/troubleshooting.md).

## Documentation and development

[Getting started](docs/getting-started.md) · [Workflows](docs/workflows.md) · [Configuration](docs/configuration.md) · [Command reference](docs/reference.md) · [Troubleshooting](docs/troubleshooting.md) · [Development](docs/development.md) · [Architecture](docs/architecture.md)

To work on the code, install dependencies and run `bun run verify` for formatting, lint, types and tests. [The development guide](docs/development.md) explains command authoring and reusable APIs.
