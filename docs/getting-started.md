[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Getting started

## Install and run

sv runs on Bun 1.4 or newer. Install [Bun](https://bun.com) first, then from this repository:

```bash
bun install --frozen-lockfile
bun run sv --help
bun link
sv doctor
```

`bun link` puts the `sv` executable on your Bun binary path. If your shell cannot find it, use `bun run sv ...` from the repository or add Bun's binary directory to `PATH` and open a new shell. Installing dependencies also installs the exact developer toolchain used by this project.

## Try a read-only command

```bash
sv inspect .
sv ready ./images                 # replace ./images with your image directory
sv ready ./images --changed      # select only working-tree changes inside a Git repo
```

`inspect` reads metadata and samples directories. `ready` recursively plans bounded image preparation; its default is preview only. Neither command applies outputs in these examples. Previewing ready can still encode images in memory to estimate output sizes.

## Apply and review a small batch

```bash
sv ready ./images --review --apply
sv history
sv undo last --dry-run
```

Read the plan before confirming. Applied outputs go to `.sv-ready/` under the command's cwd unless you choose `--out-dir`. The receipt id identifies created images and optional review HTML. Open the HTML file to compare the output, and use `sv undo OPERATION_ID --yes` only when you want to remove those recorded outputs. See [ready](ready.md) and [history](history.md).

## Keep feedback open while editing

```bash
sv watch ./images
sv watch ./posts --changed
```

Watch performs read-only checks initially and when selected inputs change. Stop it with Ctrl+C. It does not apply outputs; run ready separately to do that. For a single check use `sv watch ./posts --once --json`. [Watch output and limits](watch.md).

## Optional dependencies

| Capability                | Local dependency                                                                  |
| ------------------------- | --------------------------------------------------------------------------------- |
| Images and image review   | Installed by `bun install` through Sharp                                          |
| Video metadata/conversion | `ffprobe` / `ffmpeg` on `PATH`                                                    |
| Public Quick Tunnels      | `cloudflared` on `PATH`                                                           |
| Clipboard reads           | `pbpaste`, `wl-paste`, `xclip`, `xsel`, or PowerShell; support varies by platform |
| Bash completion           | Bash 4+ and bash-completion                                                       |
| Zsh completion            | Zsh with `compinit` initialized                                                   |

Missing optional tools do not disable unrelated commands. Doctor reports clipboard reading and clipboard copying separately; they may require different native binaries. `sv doctor` reports availability and configuration problems; it does not install anything or prove desktop/codec access. [Troubleshooting](troubleshooting.md) explains the common cases.

## Help and working directory

```bash
sv --help
sv ready --help
sv img tune --help
sv --cwd ./my-project ready . --changed
sv --verbose img web photo.png --quality 75
```

Global `--cwd` and `--verbose` options go **before** the command name. Command-specific options go after their command. Quote paths containing spaces: `sv inspect "my image.png"`. Root options configure one invocation; commands do not change your shell's directory.

## Project setup and inspection

```bash
sv inspect cover.png --json
sv inspect posts/                 # sample at most 200 immediate entries
sv doctor --json                  # optional tools missing: warnings, exit 0
sv init --dry-run --json          # preview only
sv init --yes                     # atomically create; never overwrite
```

`inspect` reads local files without writing, accessing the network or calling a model. It classifies images, videos, Markdown/MDX, blog/project directories and other files, and suggests commands without running them. Images reuse `img info` metadata; videos reuse ffprobe with local file protocols only. Missing ffprobe or unreadable media metadata produces an actionable `metadata.status: "unavailable"` with the remaining inspection intact. Missing paths, rejected symlinks and invalid relevant project configs exit 1. Directory inspection never recurses: it examines at most 200 immediate entries, excludes hidden entries, generated/vendor directories and symlinks, and reports truncation. Counts describe the sample, not the full tree. Markdown title detection reads at most 64 KiB and looks for an ATX H1.

See [configuration](configuration.md) for project discovery and blog layouts. `sv init` creates only a small project marker; most commands also work without it.

## Shell completion

```bash
# Zsh: run compinit first, then add this to ~/.zshrc
source <(sv complete zsh)

# Bash 4+: load bash-completion first, then add this to ~/.bashrc
source <(sv complete bash)
```

The generated script invokes `sv` by name, so the executable must be on `PATH`. To try it without linking, define a function in your current shell:

```bash
sv() { bun /absolute/path/to/tools/src/main.ts "$@"; }
source <(sv complete bash)
```

Use your actual checkout path and shell. Fish and PowerShell scripts are also available through `sv complete fish` and `sv complete powershell`. Those scripts pass through from Tab; the project's real-shell integration coverage is Bash and Zsh. To inspect protocol output, run `sv complete -- img web --format ""`.

## Output and exit status

Commands offer `--json` where structured output is useful. Results go to stdout; prompts and diagnostics go to stderr. Apply/start operations in JSON mode require `--yes` where documented. `share --json` is long-running: it prints its ready event and stays alive until stopped.

Exit `0` means the command completed its documented operation, `1` means a runtime failure or a command-specific failed check, and `2` means parsing/schema usage errors. Ready blocks application on validation errors; warnings can remain after image application. Use `blog check --strict` when blog warnings must also fail. `gremlins --fix --dry-run` exits nonzero while findings remain.
