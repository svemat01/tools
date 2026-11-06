[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Prepare content with ready

Start here when you have a directory of content and want to see what sv can prepare.

```bash
sv ready posts/ images/                  # preview only; no files, reports or history written
sv ready . --changed --json              # staged, unstaged and untracked files in Git
sv ready images/ --out-dir sv-ready --review --apply  # full preview, then confirmation
sv ready images/ --width 1280 --quality 75 --format webp --yes --json
sv undo OPERATION_ID --yes                 # remove the newly created outputs
```

## Preview and apply

`ready` recursively selects local content with deterministic ordering. The default is preview;
`--dry-run` explicitly requests that behavior and takes precedence over application flags.
`--apply` confirms after the full preview; `--yes` authorizes application directly.
JSON application requires `--yes`. A clean changed selection is a successful no-op.
Use root options before the command, for example `sv --cwd my-project ready . --changed`.

## Supported content and checks

V1 creates optimized **new static raster images**, preserving originals. Defaults are WebP,
1600px maximum width (no enlargement), quality 82. AVIF is also supported. Existing target-format
images within the width are skipped unless `--quality` or `--review` is explicit. Animation,
multiple pages, SVG and unknown file types are reported as unsupported. Video is inspected and
gets a suggested `video webm` command; it is never converted by `ready`. Markdown/MDX uses the
existing checks for links, media and Unicode, with suggested separate commands. Required blog
metadata and slug rules apply only when a blog configuration is present.
Validation errors block application and return a failure exit code. Warnings remain visible
and do not block image application. Ready does not rewrite posts or fix links. Blog checks run per selected
post, so this increment does not check duplicate slugs across the whole project.

## Outputs and review reports

Outputs default to `.sv-ready/` under the command's cwd. Prefer an explicit dedicated `--out-dir`.
Existing destinations receive numeric suffixes; the whole batch reserves names, including
colliding basenames from different directories. Default generated directories (`.sv-ready` and
`sv-ready`), the current output directory, history, hidden descendants and vendor/build directories
are excluded. Reuse the same explicit output directory on later runs to exclude custom outputs.
`--review` plans one offline image-review HTML per applied image, containing the chosen
encoding and a lossless resized reference. Preview emits no report. All outputs, including
reports, are recorded together through the existing file-plan executor; the result exposes
`recordId` for `history` and `undo`. Undo removes files, leaving any empty output directories.

## Application safeguards

Planning failures (missing/unreadable inputs, broken media, invalid selected project config or
exceeded budgets) block the entire application. Source fingerprints come from the exact in-memory
snapshots used for encoding; changed sources are rejected before writes. Publication is atomic
per file, not a multi-file transaction: a later race or I/O failure can return a partial receipt
for inspection/recovery. `ready` never replaces or deletes sources.

## Resource limits

Budgets are intentionally fixed: 200 selected files, 1000 traversed entries, 12 MiB per image or
Markdown input, 24 megapixels per image, width at most 2560, 64 MiB total image snapshots and
64 MiB total encoded outputs (including HTML). Reviews additionally cap embedded images at
20 MiB each. Snapshots and encoded outputs stay in memory until application; decoding uses
additional memory. Narrow targets or reduce width when a budget is exceeded. Blog checks also
read referenced local metadata/media through their existing APIs.

## Changed files

`--changed` uses NUL-delimited Git argv calls without shell evaluation. It unions staged,
unstaged and untracked paths, supports unborn HEAD and filenames containing spaces/newlines,
and scopes changes to the supplied files/directories (default cwd). Deleted files are listed as
skipped; unknown targets and use outside Git are errors. For continuous read-only feedback use the separate [`watch`](watch.md) command. Ready does not implement presets,
model-based fixes, uploads or publishing.

## Understand the result

Replace `OPERATION_ID` in examples with the receipt id printed by an applied operation. A preview lists selected files, checks, unsupported types and planned outputs. The result summarizes selected files, validation errors, warnings and informational findings. Errors block writes; warnings remain nonblocking. Use `sv blog check <path> --strict` when warnings should also fail a blog validation gate.

Generated reports can be opened as local HTML files. Reports and encoded images share one operation receipt. Run `sv history OPERATION_ID` to see the files, then `sv undo OPERATION_ID --dry-run` before reversing them. Run history and undo with the same cwd used for ready; see [history identity](history.md#where-history-lives).
