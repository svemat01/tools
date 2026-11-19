[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Everyday workflows

## Choose a starting point

| You want to…                                     | Start with                           | Read more                             |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------- |
| See what a file or directory contains            | `sv inspect <path>`                  | [Getting started](getting-started.md) |
| Prepare a small image batch, then undo if needed | `sv ready <paths>`                   | [Ready](ready.md)                     |
| See checks after local edits                     | `sv watch <paths>`                   | [Watch](watch.md)                     |
| Pick compression quality visually                | `sv img tune <image>`                | [Images](images.md)                   |
| Check posts before publication                   | `sv blog check <paths> --strict`     | [Blog](blog.md)                       |
| Review recorded changes                          | `sv history`                         | [History and undo](history.md)        |
| Save a copied image privately                    | `sv paste --out clipboard.png --yes` | [Clipboard](clipboard.md)             |
| Serve files locally or start a public session    | `sv share <directory> --dry-run`     | [Sharing](sharing.md)                 |

The examples below cover the smaller standalone utilities. Replace example filenames with your own inputs. Run any command with `--help` to see its options, or browse the [command reference](reference.md).

## Find suspicious Unicode

```bash
sv gremlins src/                       # scan, respecting .gitignore
sv gremlins docs/ --min-severity warn  # only show warnings and errors
sv gremlins docs/ --fix --dry-run      # preview safe replacements
sv gremlins docs/ --fix --yes          # apply, preserving encoding and line endings
```

Scanning and fixing are separate. `--fix` previews first, asks for confirmation on a TTY, and refuses to overwrite a file that changed after the scan. Typography replacements (curly quotes, en dashes) require `--fix-typography`. Missing targets and scan errors produce a failure exit status. Binary/non-UTF-8 files and files above `--max-bytes` are intentionally skipped and reported. Dry runs report findings as remaining and exit nonzero while findings exist. Replacement preserves file permissions. Explicit `gremlins --fix` applies across the selected file, including literal strings; review the preview when changing source code.

## Convert a recording

```bash
sv video webm clip.mp4 --width 1920 --crf 32
sv video webm recordings/ --audio strip --dry-run
```

`video` requires `ffmpeg` and `ffprobe` on `PATH`. It preserves the aspect ratio, never upscales, keeps audio as Opus unless `--audio strip` is set, and removes partial output files if encoding fails.

## Inspect or verify a JWT

```bash
# Decode without a secret; this never verifies the signature.
sv jwt decode "$TOKEN" --json

# Secrets come from the environment, a file, or stdin — never argv.
export JWT_SECRET='...'
sv jwt sign --payload '{"sub":"user-1"}' --secret-env JWT_SECRET --expires-in 1h
sv jwt verify "$TOKEN" --alg HS256 --secret-env JWT_SECRET --issuer my-app
```

`verify` requires `--alg` so a token cannot choose its own algorithm. `decode` reports `verified: false`; use `verify` when the signature matters. `--json` is available on all three commands.

## Small development helpers

```bash
sv dev --json
sv dev echo hello world --upper --repeat 2
```

`dev` reports the runtime/platform/cwd. `dev echo` is a small text helper and also demonstrates an executable command group with subcommands.
