[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Recorded operations and undo

Replace `OPERATION_ID` in examples with a receipt id printed by an applied operation.

Use history for explicit file operations created by `ready` or `img web --record`. It is local file-operation history, separate from shell history.

```bash
sv img web photo.png --record --json  # includes recordId; preserves the input
sv history                           # receipts for this canonical cwd
sv history OPERATION_ID --json
sv undo last --dry-run --json         # validates every output, input and backup
sv undo OPERATION_ID --yes                    # delete created files; restore replacements
sv undo OPERATION_ID --yes --json             # JSON application always requires --yes
```

`img web` recording is opt-in through `--record`; applied `ready` outputs are recorded automatically. Replacement backups retain original file contents and receipts retain explicit file paths. Both workflows plan their output batch before writing and leave originals in place. Applied results identify the receipt for history and undo. Recorded conversion refuses an output equal to its source; choose a separate output. `--force --record` can replace a separate existing target and back it up. Dry runs and skipped conversions create no history. Blog preparation, the other image commands, JWT and clipboard workflows do not create these receipts.

## Where history lives

Version 1 receipts live under `$XDG_STATE_HOME/sv`, or `$HOME/.local/state/sv` (OS home fallback), partitioned by the SHA-256 of the canonical cwd. Running in a different directory selects different history; no project discovery is performed. State directories use mode 0700; backups and receipts use 0600. Created outputs are not duplicated in state. Only replacement originals are backed up. Receipts contain explicit operations, hashes, modes, timestamps and application/undo status; they never capture argv, environment or stdin. History reads and undo previews do not create state directories. There is no automatic retention policy yet.

## Undo safeguards

Undo previews before asking for confirmation. Noninteractive application requires `--yes`; `--dry-run` validates without mutation. Undo refuses the whole plan when an output or source changed, or a replacement backup is corrupt. It never recursively removes directories. Individual publications are atomic; multi-file plans and undo are **not transactions**. Cancellation or runtime failure retains a `partial` receipt with per-file progress. A crash during publication may leave `applying`; undo checks the actual bytes before proceeding. An interrupted `undoing` file requires manual inspection. The per-project lock serializes writers, waits up to two seconds, and fails closed on a stale lock; inspect the operation and remove the reported lock only when no writer is active. As with existing safe file writes, validation and publication have a small filesystem race window against unrelated concurrent writers; this is not an adversarial filesystem isolation mechanism.

## If an operation stops partway through

Inspect the receipt before retrying. `partial` records which files were applied; an `applying` file can be checked by undo against actual bytes. `undoing` means restoration was interrupted and requires manual inspection. See [recovery steps](troubleshooting.md#undo-and-partial-operations).
