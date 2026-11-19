[Home](../README.md) · [Getting started](getting-started.md) · [Workflows](workflows.md) · [Command reference](reference.md) · [Troubleshooting](troubleshooting.md)

# Images

Inspect dimensions, produce web images, resize covers, compare outputs, or review encoding quality visually. Run `sv img <command> --help` for all options.

## Convert, resize and compare

```bash
# Convert a batch to WebP, capped at 1600px wide, without overwriting anything.
sv img web posts/ --width 1600 --quality 82

# Optimize OpenGraph covers. PNG stays PNG unless --format says otherwise.
sv img og covers/*.png --target 1200x630 --strict

# Resize with aspect-ratio-aware fitting. Upscaling is off by default.
sv img resize hero.jpg --width 1280 --fit cover

# Compare two builds; exit 1 when more than 0.5% of pixels differ.
sv img compare before.png after.png --max-diff 0.5

# Inspect dimensions, format, size and animation metadata.
sv img info cover.png hero.jpg
```

## Output behavior

Existing outputs are never replaced unless you pass `--force`; otherwise the tool picks `name-1.webp`, `name-2.webp`, and so on. Batch destinations are reserved during planning, so dry runs handle colliding filenames consistently. If an output appears after planning, writing fails instead of replacing it. `--dry-run` performs the transform to report sizes but writes no files. Originals are preserved by default; `--force` can replace an original when it is also the output path.

`img web` preserves existing target-format bytes when resizing is unnecessary. Pass `--reencode` or an explicit `--quality` to recompress them. `--force` controls replacement, independently of recompression. `img og` preserves PNG pixel values by default; `--palette` explicitly enables palette quantization.

## Choose quality visually

`sv img tune hero.jpg --width 1600 --qualities 60,75,85 --format webp --out review.html` exports one self-contained offline HTML review. Select quality, drag the comparison divider, zoom to output pixels and scroll to pan both images together. Download the selected encoded image or copy its reproducible conversion command from the report. Commands use source/output filenames rather than private absolute paths; run them from the source image directory in a POSIX shell. If browser clipboard access is unavailable, the command is selected for manual copying. `--json` prints the report path and variant metadata; no application opens unless `--open` is explicit, and no separate variant files are written. `sv img tune hero.jpg --open` opens the completed report with your local default application. Existing report names receive a numeric suffix, including explicit `--out`; there is no overwrite option.

Tune defaults to WebP, width 1600 and qualities 60,75,85, never upscales, applies orientation, and strips metadata. The original reference is a lossless PNG at the output dimensions; byte savings compare each encoding with the source file. Only the filename and relevant dimensions/settings are included. V1 accepts static raster images supported by Sharp, rejects SVG and animation/multiple pages, and caps inputs at 12 MiB/24 megapixels, width at 2560, distinct qualities at five, and total embedded image bytes at 20 MiB (roughly 27 MiB HTML). Reduce width or variant count if the report budget is exceeded. AVIF is optional and slower. Source files are preserved.

## Choose a workflow

- Use `img web` for a known conversion, `img resize` for geometry, and `img og` for cover dimensions.
- Use `img tune` when you want to choose quality by looking at the result.
- Use [`ready`](ready.md) for a preview-first image batch with recorded outputs and optional reports.
- Add `--record` to `img web` when you need [history and undo](history.md).

On interactive terminals, tuning reports inspect/encode/review/write stages on stderr before printing the finished report URL. Redirected output and JSON omit transient progress. An opener failure leaves the report saved and provides its file URL for manual opening.
