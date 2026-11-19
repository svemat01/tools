[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Watch content without changing it

`watch` runs read-only ready checks initially and again when selected filesystem metadata changes. It never applies outputs, creates reports or records history. Use it while editing, then run `ready --apply` separately when you want to review and apply a plan.

```bash
sv watch ./posts ./images                  # initial check, then checks after changes
sv watch . --changed                       # only staged, unstaged and untracked Git paths
sv watch ./images --interval 2000           # poll every two seconds
sv watch ./posts --once --json              # one machine-readable check, then exit
sv --cwd ./my-project watch . --changed     # global options precede the command
```

## What triggers a check

The watcher polls local metadata rather than opening a native filesystem notification stream. `--interval` is in milliseconds: default 1000, minimum 100, maximum 60000. A check runs when its bounded selection signature changes; unchanged polls do not re-encode images. The signature covers file identity, size and timestamps, selected Git paths, and relevant project configuration markers.

The default target is the command's cwd. Directory discovery follows ready's generated/vendor/history exclusions and skips hidden descendants. Git selection uses the same staged/unstaged/untracked behavior as [`ready --changed`](ready.md#changed-files). The initial scan and subsequent changed scans use ready's content checks and image-planning budgets. Checks can encode images in memory to estimate outputs, so narrow the targets or increase the interval for larger projects.

When a post references sibling metadata or assets, watch its directory rather than only the Markdown file to observe those dependencies. Metadata polling is intended for local interactive feedback. It is not a byte-by-byte audit or a guarantee of observing every intermediate save. Run a fresh `ready` or `blog check --strict` when you need a final deliberate validation.

## Results and exit status

Human output summarizes files, planned outputs, validation errors and warnings, then prints actionable findings. An error blocks preparation; a warning remains visible without blocking it. The check writes no files even when the summary lists planned outputs.

Without `--once`, the command stays alive until Ctrl+C or another cancellation signal. A blocked check is reported and the watcher keeps waiting for a fix. Normal cancellation of continuous watching exits successfully. For a one-shot scripting or CI check, use `--once`: validation failures and cancellation exit 1.

## JSON is one event per line

`--json` emits newline-delimited JSON (NDJSON), not one JSON document containing the whole session. Each check includes:

- `command: "watch"`, `schemaVersion: 1`, and a sequence number.
- `event: "check"` for completed checking or `"error"` for an inspection failure.
- `reason: "initial" | "change"` and `status: "planned" | "reused" | "noop" | "blocked"`.
- Validation counts in `checks`, selection/new-output/`reusedOutputs` counts in `summary`, plus `failures` and `issues`.

The process remains running in continuous mode. Consume events as lines arrive rather than waiting for stdout to close. Use `--once --json` when you want a single event and an exit code. Startup messages and diagnostics stay on stderr.

To apply a change after reviewing feedback:

```bash
sv ready ./images --review --apply
```

Watch does not accept an apply mode, run shell commands, start a server, call a model, or publish content.

Checks reuse verified recorded outputs under the same rules as [ready](ready.md#repeat-preparation-without-duplicate-outputs). Output verification occurs when a check runs; the watcher still triggers on selected inputs/configuration, not every change to generated outputs or history. Start a fresh one-shot check to revalidate those dependencies immediately. Interactive checking shows transient progress on stderr; NDJSON omits it.
