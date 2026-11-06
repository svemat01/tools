[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Sharing files and local services

Use `share` for a preview, an optional expiry, and an owned sharing session. Use `tunnel` when you only need the direct Cloudflare wrapper.

```bash
sv share ./site --dry-run --json   # read-only manifest; no listener or tunnel
sv share ./site --yes              # 127.0.0.1, automatically selected port
sv share 3000 --yes --timeout 30m   # point to an existing loopback HTTP service
sv share 'http://[::1]:8080/' --public --yes --json
sv share ./site --public --copy    # confirm exact exposure, then copy the URL
```

## Preview and approve a session

`share` previews the exact target and static file manifest before asking to start. Human preview-only output goes to stdout; a start plan and JSON diagnostics go to stderr. `--yes` approves noninteractive starts; JSON starts require it. `--preview` aliases `--dry-run`: both only inspect, even with `--public`, `--copy` or `--yes`. Local mode serves only loopback, needs no optional binaries, and opens no browser. Existing service targets are parsed without DNS lookup or HTTP requests: only HTTP(S), no credentials/fragments, ports 1–65535, and exact `localhost`, canonical IPv4 in 127/8, or IPv6 `[::1]`. A bare port selects `http://127.0.0.1:PORT/`. The service owns its responses, redirects and routes; sharing a URL path does not restrict public access to that path.

## Static files and exclusions

Static sessions bind only `127.0.0.1`; `--port 0` (default) chooses a free port. Inspection fails above 5,000 traversed entries, 1,000 files, 100 MiB total or 16 nested directory levels. Dotfiles (including `.env` and `.git`), symlinks and `node_modules`, `vendor`, `dist`, `build`, `coverage`, `target`, `out` directories are skipped. Use an explicit static output directory as the target to share its contents. Symlinks in the selected path or its ancestors are refused. The manifest is fixed for the session: new files are unavailable, and edited/replaced files require restarting. Every read checks path components, opens without following a final symlink and verifies the file identity before and after a bounded read. GET and HEAD are supported with MIME types; a small escaped file listing is generated at `/` when there is no root `index.html`. No custom routes or script callbacks run in the server.

## Public URLs, output and stopping

`--public` explicitly starts the existing `cloudflared` Quick Tunnel lifecycle after approval; anyone with the link can access the selected static files or the entire existing service. Missing `cloudflared` reports installation guidance. No account, domain or persistent configuration is created. `--json` emits one `{command:"share", schemaVersion:1, event:"ready", url, mode, target}` event as soon as the local listener or public URL is ready, then stays alive. Plans and diagnostics remain on stderr. `--timeout` accepts `ms`, `s`, `m`, `h` (for example `30s` or `1.5h`); expiry and Ctrl+C stop the owned listener/tunnel. An existing service remains running. `--copy` calls the best-effort clipboard API only after readiness, with a three-second deadline and cancellation support. QR codes, authentication and a dashboard are deferred.

## Direct tunnel wrapper

```bash
sv tunnel 3000
sv tunnel 8080 --host 127.0.0.1 --copy
```

`tunnel` prints an exposure warning, starts a Cloudflare Quick Tunnel with `cloudflared`, prints the public URL, and cleans up the child process on Ctrl+C. It does not require a Cloudflare account. Quick Tunnel URLs are temporary and public; do not expose sensitive services. `--json` emits the URL as soon as the tunnel is ready and keeps running until stopped.
