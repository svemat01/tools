[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Clipboard input

```bash
sv paste --json                        # metadata only; no clipboard text is printed
sv paste --out clipboard.png --yes     # save PNG bytes without overwriting
sv --cwd ./notes paste --out clip.txt --yes --json
```

`paste` explicitly reads the clipboard and classifies PNG images, JWT-shaped text, readable path lists (up to 256 entries), HTTP(S) URLs and generic text. Summaries omit clipboard text, paths, URL contents and tokens; summaries offer safe actions without reconstructing raw clipboard text. After an explicit save, suggested commands use the actual saved destination and preserve `--cwd`. JWT detection does not decode or verify a token. Path classification checks local readability only and never executes a path or follows a URL over the network. No models, history receipts or backups are involved.

`--out` previews the absolute destination on stderr and asks for confirmation. Noninteractive saves and JSON saves require `--yes`. Saves preserve the exact selected bytes, leave the clipboard intact, use private file permissions (0600), and atomically refuse an existing destination, including symlinks. PNG output must end in `.png`; text cannot be saved under a known image extension. There is no implicit conversion. Read-only summaries write no files.

Readers use available native tools: `pbpaste` on macOS (text only), `wl-paste` on Wayland (preferred in a Wayland session), `xclip` on X11 (text/PNG), `xsel` (text only), or `powershell.exe` on Windows/WSL (text only). No GUI package is required by sv. Missing tools and failed desktop access produce actionable errors. PNG is preferred over a text representation when advertised; other advertised image formats are explicitly unsupported. Empty/text-incompatible selections on text-only backends are rejected; use a PNG-capable reader for image input. No clipboard data is interpolated into shell commands or child diagnostics.

Limits are 16 MiB of clipboard data, a shared three-second deadline for format negotiation and process reading, and a 64 KiB format listing. PNG validation also enforces 16 million pixels. Native image decoding checks cancellation when it returns; it cannot be interrupted instantly.

After saving a clipboard image, use `sv img tune clipboard.png` for visual quality selection or `sv ready clipboard.png` to preview a recorded conversion. Clipboard saves themselves are never added to operation history.
