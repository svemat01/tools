[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Troubleshooting and recovery

## sv is not found

Run `bun run sv --help` from the checkout to verify the source command works. If it does, run `bun link`, check that Bun's binary directory is on `PATH`, and open a fresh shell. Shell completion also needs `sv` to resolve by name.

## An option is unexpected

Global `--cwd` and `--verbose` belong before the subcommand:

```bash
sv --cwd ./project ready . --changed
sv --verbose img web photo.png --quality 75
```

`sv ready . --cwd ./project` is invalid. Quote paths with spaces. Use `sv <command> --help` for the options of that exact command; not every command accepts `--dry-run`, `--force` or `--yes`.

## doctor reports a missing optional tool

Images and local static sharing still work without video/tunnel binaries. Install FFmpeg to provide both `ffmpeg` and `ffprobe`; install `cloudflared` only for public tunnels. Put them on `PATH`, then run `sv doctor` again. Doctor checks presence, not codec support or whether a desktop session permits clipboard access.

## ready made no files

The default is preview. Use `--apply` to confirm after seeing the plan, or `--yes` for deliberate noninteractive application. `--dry-run` always wins over apply flags. Same-format images already within the width limit are skipped unless `--quality` or `--review` is explicit. Unsupported file types receive checks/suggestions rather than outputs.

Default output is `.sv-ready/` under the command's cwd, not alongside every source. Files are created with suffixes when a target already exists. Reuse your custom `--out-dir` to exclude it on later runs. Read [ready](ready.md) for budgets and exclusions.

## ready reports validation issues

Ready blocks image application when content validation finds errors. Warnings and informational findings do not block it. Generic Markdown is checked for links, media and Unicode; required blog metadata and slug checks apply when blog configuration is present. Use `sv blog check <paths> --strict` when warnings must fail a blog gate, and `sv blog prepare <paths> --dry-run` to review proposed text changes. Ready itself does not rewrite posts.

## --changed is empty or fails

It selects staged, unstaged and untracked working-tree changes, scoped to your targets. It does not select files merely because they differ in an earlier commit. Run from a Git working tree, use the right `--cwd`, and narrow targets when selection exceeds the file budget. Deleted paths are reported as skipped. A clean selection is a successful no-op.

## Watch appears idle or a JSON consumer waits forever

Watch checks once, then polls metadata and emits again only when the selection signature changes. Continuous `--json` output is one JSON event per line; the process remains alive. Consume lines as they arrive or use `--once --json` for a single event and exit status. A blocked continuous check keeps waiting so you can fix the input. [Watch guide](watch.md).

## A batch exceeds a limit

Select fewer files or a smaller subtree. Reduce `--width` or the number of quality variants for image reports. Ready and sharing intentionally bound discovery and bytes; their guides give exact limits. Previewing ready can use CPU and memory because it actually encodes candidate outputs.

## Undo and partial operations

Run history and undo from the same canonical cwd used for the recorded operation:

```bash
sv --cwd ./project history
sv --cwd ./project history OPERATION_ID --json
sv --cwd ./project undo OPERATION_ID --dry-run --json
```

Replace `OPERATION_ID` with the id printed when outputs were applied. `last` selects the most recent receipt not marked undone; it is not shell history. Only recorded operations can be undone. Blog preparation and clipboard saves are not recorded.

If an output or source changed, undo refuses the whole preflight. Inspect the receipt and the files rather than adding a force flag: undo has no force mode. A corrupt replacement backup also blocks undo.

`partial` means a runtime failure or cancellation stopped a multi-file operation. Inspect the receipt for per-file progress. For an `applying` file, undo can skip a missing new output or a replacement that still contains its original bytes. Other `applying` files need manual inspection because matching bytes alone cannot establish who published the file. An `undoing` file also needs manual inspection because restoration may have been interrupted.

A stale writer lock fails closed. The error prints the lock path. Confirm no operation is still running before manually removing that exact lock. Do not delete receipt or backup directories as a way to force undo. There is no automatic backup-retention cleanup yet.

## Clipboard access fails

The terminal needs access to an active desktop clipboard session. A binary being installed does not prove that access. Doctor has separate `clipboard-read` and `clipboard-copy` checks; a copy-only binary does not support paste. Wayland uses `wl-paste`; X11 uses `xclip` or `xsel`; macOS uses `pbpaste`; Windows/WSL can use PowerShell. The current macOS/xsel/PowerShell readers are text-only. PNG input requires `wl-paste` or `xclip`; an advertised JPEG clipboard format is not automatically converted.

`sv paste --json` prints metadata only. To save PNG bytes, use an output ending in `.png`. Text cannot be saved with a known image extension. Existing destinations are refused; choose a new name. Secrets are never automatically copied into operation history.

## Completion does not work

Check that `sv` is on `PATH`. Zsh needs `compinit`; Bash needs version 4 or newer plus bash-completion loaded before sourcing the generated script. Source `sv complete <shell>` in the same shell you configured. See [setup](getting-started.md#shell-completion). Fish/PowerShell are generated by the underlying Tab library and do not have the same real-shell test coverage here.

## A share session has no ready URL or stops responding

Use `--dry-run` first to inspect the target. Local static sharing needs no cloudflared. Public mode needs cloudflared and connectivity; diagnostics stay on stderr. `--json` emits a ready event and remains running, so consuming stdout until process exit will delay your client.

Static sharing uses a fixed manifest. Restart after editing/replacing files or adding new files. Dotfiles, symlinks and generated/vendor descendants are excluded. Use an explicit output directory as the target to share a build. A service URL is unprobed and its path does not limit all routes that may be exposed publicly.

Stop with Ctrl+C or use `--timeout 30m`. An existing local service remains running when sv stops; sv owns only its listener and tunnel.

## JWT decoding says verified: false

Decoding only reads claims and headers; it does not validate the signature. Use `jwt verify` with an explicit `--alg` and key source. Issuer/audience expectations are additional options. You can use `--file` or `--stdin` to avoid placing a token in argv; secrets use environment, a file or stdin and are never accepted directly in argv. One invocation can read only one value from stdin.
