[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Blog checks and preparation

`blog` is layout-agnostic. Point it at a project root and describe the layout in `sv.blog.json` (or `.sv/blog.json`, or `blog.config.json`). See [`examples/ens-blog/sv.blog.json`](../examples/ens-blog/sv.blog.json) for a complete example.

```bash
sv blog check posts/ --strict
sv blog prepare posts/ --dry-run
sv blog prepare posts/ --yes
```

`check` validates metadata, local links and media, alt text, slugs, oversized assets, Notion export artifacts, tracking parameters and Unicode. `prepare` previews every edit before writing, removes Notion artifacts, strips tracking parameters, replaces invisible characters, normalizes blank lines, and rewrites referenced images. Deletion requires `prepare.deleteOriginals: true` (or `--delete-originals`). Even then, shared/public assets and originals with possible remaining references are preserved. Cleanup protects code, frontmatter and MDX expressions; ambiguous URL source syntax is left unchanged. Functional query parameters such as `s`, `source` and `ref` are preserved.

Preparation shares image plans across posts and checks input fingerprints before applying changes. Entries are updated sequentially; originals are considered for deletion only after all entries succeed. Individual writes are atomic, but the batch has no rollback: failures report completed writes for recovery. Encoded image data is held once per unique asset until application. JSON output requires `--yes` to apply (`--dry-run --json` previews without approval). It never publishes or opens a pull request.

Minimal config:

```json
{
  "name": "My blog",
  "postsDir": "posts",
  "entries": ["index.md", "index.mdx"],
  "metadataFiles": ["meta.json"],
  "requiredMetadata": ["title", "slug"],
  "slugField": "slug",
  "prepare": {
    "imageFormat": "webp",
    "imageWidth": 1600,
    "imageQuality": 82
  }
}
```

## Choose check or prepare

`blog check` is read-only. Exit 1 means issues need attention; `--strict` also fails on warnings. Use it as a content gate before publishing.

`blog prepare` plans edits, previews them, and asks before applying unless `--yes` is given. It does not use the general operation-history executor, so `sv undo` cannot reverse blog preparation. Keep your work in version control and review the resulting diff.

Configure layouts in [blog configuration](configuration.md#blog-configuration). The small `sv.config.json` project marker does not replace this file.
