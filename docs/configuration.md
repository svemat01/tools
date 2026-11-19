[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Configuration

Project discovery walks from the requested directory (or a file's parent) through ancestors. The nearest directory containing a marker wins. At that directory the precedence is `sv.config.json`, `sv.blog.json`, `.sv/blog.json`, `blog.config.json`, `.git`, then `package.json`. Both the sv config and the first blog config at the selected root are validated; malformed configs fail rather than silently falling back. Symbolic link paths/configs are refused.

`init` targets the discovered project root, or the current directory when no marker exists. It previews the exact path and contents on stderr, then confirms interactively or requires `--yes` for noninteractive/JSON creation. `--dry-run` always previews without writing. Existing sv or blog configuration is reported unchanged. Version 1 is deliberately minimal:

```json
{ "schemaVersion": 1 }
```

Extra fields and unsupported versions are rejected. Blog behavior continues to use its existing blog config. `doctor` checks Bun >=1.4.0, presence of ffmpeg, ffprobe, cloudflared and clipboard capabilities, plus selected project config validity. Clipboard reading and copying are separate checks: installing a writer does not enable `paste`. Optional missing tools warn with setup advice; invalid config/runtime exits 1. It never installs anything, executes the optional binaries or prints environment values. Binary presence does not guarantee desktop clipboard access or codec support.

## Blog configuration

Blog commands load `sv.blog.json`, `.sv/blog.json`, or `blog.config.json` from the command's cwd, or accept an explicit `--config <path>`. Project-aware inspection/ready discover their project root first. Point `--cwd` at the project root when you want consistent configuration and output paths.

```bash
sv --cwd ./my-blog blog check posts/ --strict
sv --cwd ./my-blog blog prepare posts/ --dry-run
```

For a minimal blog file and preparation behavior, see the [blog guide](blog.md). The [ENS example](../examples/ens-blog/sv.blog.json) shows a fuller layout. `sv.config.json` currently accepts only `schemaVersion`; put blog options in the blog file rather than adding unsupported fields.

## Local history storage

Recorded operations use `$XDG_STATE_HOME/sv`, or `$HOME/.local/state/sv` with an OS-home fallback. History is partitioned by canonical cwd. Use the same `--cwd` for recorded ready/image operations and their history/undo commands. [History](history.md) describes stored data, permissions, backups and recovery.

## Defaults without named presets

`ready` accepts width, quality, format and output-directory options per invocation. Named presets and configuration-driven encoding defaults are not implemented. Use your shell script or task runner to reuse a preferred invocation.
