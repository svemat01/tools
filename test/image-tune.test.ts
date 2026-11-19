import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

import sharp from "sharp";

import { app } from "../src/app.ts";
import { renderImageReview } from "../src/lib/image-review.ts";
import {
  buildImageTuneReport,
  createImageReview,
  TUNE_LIMITS,
  validateTuneOptions,
} from "../src/lib/image-tune.ts";
import { runApp } from "./support/io.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sv-tune-test-"));
  roots.push(root);
  const input = join(root, 'photo<&".jpg');
  await sharp({ create: { width: 40, height: 20, channels: 3, background: "#fa8030" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(input);
  return { root, input };
}
function decode(url: string) {
  return Buffer.from(url.split(",")[1]!, "base64");
}

test("embedded bytes are oriented, bounded, stripped and truly encoded in selected formats", async () => {
  const { input } = await fixture();
  const before = await readFile(input);
  const { review, html } = await buildImageTuneReport(input, { width: 16, qualities: [60, 85] });
  expect(review.source).toMatchObject({ bytes: before.length, width: 20, height: 40, format: "jpeg" });
  expect(review.reference).toMatchObject({ width: 16, height: 32 });
  for (const [index, image] of [review.reference, ...review.variants].entries()) {
    const buffer = decode(image.url);
    const metadata = await sharp(buffer).metadata();
    expect(metadata).toMatchObject({ format: index === 0 ? "png" : "webp", width: 16, height: 32 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(image.bytes).toBe(buffer.length);
  }
  expect(review.variants[0]!.savings).toBeCloseTo(100 * (1 - review.variants[0]!.bytes / before.length));
  expect(await readFile(input)).toEqual(before);
  const embedded = JSON.parse(
    html.match(/<script id="review-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!,
  );
  expect(embedded).toMatchObject(review);
  expect(embedded.commands).toHaveLength(review.variants.length);
  expect(embedded.commands[0]).toContain("sv img web");
  expect(html).not.toContain(input);
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  expect(() => new Script(script)).not.toThrow();
  expect(script).not.toContain("innerHTML");
  const avif = await createImageReview(input, { width: 100, qualities: [70], format: "avif" });
  expect(await sharp(decode(avif.variants[0]!.url)).metadata()).toMatchObject({
    format: "heif",
    width: 20,
    height: 40,
    compression: "av1",
  });
  expect(avif.variants[0]!.filename).toEndWith("-q70.avif");
});

test("untrusted filenames cannot escape inert JSON or inject HTML/script", async () => {
  const { input } = await fixture();
  const review = await createImageReview(input, { qualities: [75] });
  const attack = '</script><img src=x onerror="alert(1)">\u2028&';
  const html = renderImageReview({
    ...review,
    filename: attack,
    variants: review.variants.map((v) => ({ ...v, filename: attack })),
  });
  expect(html).not.toContain(attack);
  expect(html.match(/<script\b/g)).toHaveLength(2);
  const data = html.match(/type="application\/json">([\s\S]*?)<\/script>/)![1]!;
  expect(JSON.parse(data).filename).toBe(attack);
  expect(html).not.toMatch(/<script[^>]+src=/);
  expect(html).toContain("connect-src 'none'");
});

test("CLI mounts tune, emits metadata without payloads, and never replaces report or source", async () => {
  const { root, input } = await fixture();
  const source = await readFile(input);
  await writeFile(join(root, "review.html"), "existing");
  const args = [
    "img",
    "tune",
    input,
    "--qualities",
    "60,85",
    "--out",
    "review.html",
    "--width",
    "12",
    "--json",
  ];
  const result = await runApp(app, args, { cwd: root });
  expect(result.code).toBe(0);
  const value = JSON.parse(result.stdout);
  expect(value).toMatchObject({
    command: "img tune",
    report: "review-1.html",
    variants: [
      { quality: 60, width: 12, height: 24 },
      { quality: 85, width: 12, height: 24 },
    ],
  });
  expect(result.stdout).not.toContain("base64");
  expect(await readFile(join(root, "review.html"), "utf8")).toBe("existing");
  expect(await readFile(input)).toEqual(source);
  expect(await readFile(join(root, value.report), "utf8")).toStartWith("<!doctype html>");
  const defaults = await runApp(app, ["img", "tune", input, "--json"], { cwd: root });
  expect(defaults.code).toBe(0);
  expect(JSON.parse(defaults.stdout).variants).toHaveLength(3);
  const single = await runApp(app, ["img", "tune", input, "--qualities", "80", "--json"], { cwd: root });
  expect(single.code).toBe(0);
  expect(JSON.parse(single.stdout).variants).toHaveLength(1);
  const help = await runApp(app, ["img", "tune", "--help"]);
  expect(help.stdout).toContain("--qualities");
});

test("resource limits and unsupported SVG/animation fail explicitly without output", async () => {
  for (const options of [
    { width: 2561 },
    { qualities: [] },
    { qualities: [60, 60] },
    { qualities: [0] },
    { qualities: [1, 2, 3, 4, 5, 6] },
  ])
    expect(() => validateTuneOptions(options)).toThrow();
  const { root, input } = await fixture();
  const svg = join(root, "image.svg");
  await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  await expect(createImageReview(svg)).rejects.toThrow("Unsupported tune input format");
  const animation = join(root, "animation.gif");
  await sharp(Buffer.concat([Buffer.alloc(12), Buffer.alloc(12, 255)]), {
    raw: { width: 2, height: 4, channels: 3, pageHeight: 2 },
  })
    .gif()
    .toFile(animation);
  await expect(createImageReview(animation)).rejects.toThrow("Animated or multi-page");
  const large = join(root, "large.png");
  await sharp({ create: { width: 5000, height: 5000, channels: 3, background: "red" } })
    .png()
    .toFile(large);
  await expect(createImageReview(large)).rejects.toThrow("24 megapixel");
  const huge = join(root, "huge.png");
  await writeFile(huge, Buffer.alloc(TUNE_LIMITS.inputBytes + 1));
  await expect(createImageReview(huge)).rejects.toThrow("12 MiB");
  const invalid = await runApp(app, ["img", "tune", input, "--qualities", "60,60", "--json"], { cwd: root });
  expect(invalid.code).toBe(1);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("unique");
  const badWidth = await runApp(app, ["img", "tune", input, "--width", "9999"], { cwd: root });
  expect(badWidth.code).toBe(2);
});

test("emitted controls select downloads, zoom a shared grid and move the divider", async () => {
  const { input } = await fixture();
  const { html, review } = await buildImageTuneReport(input, { qualities: [60, 85] });
  const script = html.match(/<script>\n([\s\S]*?)<\/script>/)![1]!;
  // Execute the emitted script against a minimal DOM contract; no browser/server needed.
  class Element {
    textContent = "";
    value = "0";
    src = "";
    href = "";
    download = "";
    clientWidth = 10;
    style: Record<string, string> = {};
    events: Record<string, (event?: unknown) => void> = {};
    children: Element[] = [];
    selected = false;
    focused = false;
    focus() {
      this.focused = true;
    }
    select() {
      this.selected = true;
    }
    append(child: Element) {
      this.children.push(child);
    }
    addEventListener(name: string, handler: (event?: unknown) => void) {
      this.events[name] = handler;
    }
  }
  const ids = [
    "review-data",
    "title",
    "source",
    "original",
    "encoded",
    "quality",
    "download",
    "stats",
    "zoom",
    "viewport",
    "stage",
    "divider",
    "line",
    "image-status",
    "conversion-command",
    "copy-command",
    "command-status",
  ];
  const nodes = Object.fromEntries(ids.map((id) => [id, new Element()]));
  const node = (id: string) => nodes[id]!;
  node("review-data").textContent = html.match(/type="application\/json">([\s\S]*?)<\/script>/)![1]!;
  node("zoom").value = "fit";
  node("divider").value = "50";
  new Script(script).runInNewContext({
    document: { getElementById: node, createElement: () => new Element() },
    window: { addEventListener() {} },
  });
  expect(node("quality").children).toHaveLength(2);
  expect(node("conversion-command").value).toContain("--quality 60");
  await node("copy-command").events.click!();
  expect(node("command-status").textContent).toContain("copy it manually");
  expect(node("conversion-command").selected).toBe(true);
  expect(node("conversion-command").focused).toBe(true);
  expect(node("original").src).toBe(review.reference.url);
  expect(node("encoded").src).toBe(review.variants[0]!.url);
  expect(node("quality").children[0]!.textContent).toContain("bytes");
  node("encoded").events.error!();
  expect(node("image-status").textContent).toContain("could not display");
  expect(node("download").href).toBe(review.variants[0]!.url);
  node("encoded").events.load!();
  expect(node("image-status").textContent).toBe("");
  node("quality").value = "1";
  node("quality").events.change!();
  expect(node("download").download).toBe(review.variants[1]!.filename);
  expect(node("download").href).toBe(review.variants[1]!.url);
  expect(node("conversion-command").value).toContain("--quality 85");
  node("zoom").value = "4";
  node("zoom").events.change!();
  expect(node("stage").style).toMatchObject({ width: "80px", height: "160px", imageRendering: "pixelated" });
  node("divider").value = "75";
  node("divider").events.input!();
  expect(node("encoded").style.clipPath).toBe("inset(0 0 0 75%)");
  expect(node("line").style.left).toBe("75%");
  let copied = "";
  new Script(script).runInNewContext({
    document: { getElementById: node, createElement: () => new Element() },
    window: { addEventListener() {} },
    navigator: {
      clipboard: {
        async writeText(text: string) {
          copied = text;
        },
      },
    },
  });
  await node("copy-command").events.click!();
  expect(copied).toBe(node("conversion-command").value);
  expect(node("command-status").textContent).toBe("Command copied.");
});

test("large lossless reference is refused rather than creating an oversized HTML report", async () => {
  const { root } = await fixture();
  const input = join(root, "noise.jpg");
  const data = Buffer.alloc(1800 * 4400 * 3);
  let state = 1234567;
  for (let i = 0; i < data.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 255;
  }
  await sharp(data, { raw: { width: 1800, height: 4400, channels: 3 } })
    .jpeg({ quality: 70 })
    .toFile(input);
  await expect(createImageReview(input, { width: 1800, qualities: [75] })).rejects.toThrow(
    "20 MiB embedded image limit",
  );
});

test("conversion commands preserve hostile filenames as inert arguments without private paths", async () => {
  const { root } = await fixture();
  const filename = "a 'quoted' $(should-stay-data).png";
  const input = join(root, filename);
  await sharp({ create: { width: 12, height: 8, channels: 3, background: "blue" } })
    .png()
    .toFile(input);
  const { html, review } = await buildImageTuneReport(input, { width: 8, qualities: [61] });
  const embedded = JSON.parse(html.match(/type="application\/json">([\s\S]*?)<\/script>/)![1]!);
  const command = embedded.commands[0] as string;
  expect(command).not.toContain(root);
  const argvLog = join(root, "argv.log");
  const child = Bun.spawn(["bash", "-c", 'sv() { printf "%s\\0" "$@" > "$SV_ARGV_LOG"; }; ' + command], {
    cwd: root,
    env: { ...process.env, SV_ARGV_LOG: argvLog },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  expect((await readFile(argvLog, "utf8")).split("\0").slice(0, -1)).toEqual([
    "img",
    "web",
    `./${filename}`,
    "--width",
    "8",
    "--format",
    "webp",
    "--quality",
    "61",
    "--out",
    `./${review.variants[0]!.filename}`,
  ]);
  expect(html).toContain("source image's directory");
});

test("tune explicitly opens reports through a fixture opener and reports honest fallback", async () => {
  const { root, input } = await fixture();
  const called = join(root, "opened.log");
  const opener = join(root, process.platform === "darwin" ? "open" : "xdg-open");
  await writeFile(opener, '#!/bin/sh\nprintf "%s" "$1" > "$SV_OPEN_LOG"\n');
  await chmod(opener, 0o755);
  const options = { cwd: root, env: { PATH: root, SV_OPEN_LOG: called } };
  const silent = await runApp(app, ["img", "tune", input, "--qualities", "75", "--json"], options);
  expect(silent.code).toBe(0);
  expect(await Bun.file(called).exists()).toBe(false);
  expect(JSON.parse(silent.stdout)).toMatchObject({ openRequested: false, opened: false });
  const opened = await runApp(app, ["img", "tune", input, "--qualities", "75", "--open", "--json"], options);
  expect(opened.code).toBe(0);
  expect(JSON.parse(opened.stdout)).toMatchObject({ openRequested: true, opened: true });
  expect(await readFile(called, "utf8")).toBe(JSON.parse(opened.stdout).reportUrl);
  const unavailable = await runApp(app, ["img", "tune", input, "--qualities", "75", "--open", "--json"], {
    cwd: root,
    env: { PATH: "/nonexistent" },
  });
  expect(unavailable.code).toBe(0);
  expect(JSON.parse(unavailable.stdout)).toMatchObject({ openRequested: true, opened: false });
  expect(unavailable.stderr).toContain("Report saved");
  expect(await Bun.file(join(root, JSON.parse(unavailable.stdout).report)).exists()).toBe(true);
});

test("tune reports actual inspect, encode and review work through optional progress hooks", async () => {
  const { input } = await fixture();
  const events: { phase: string; current?: number; total?: number }[] = [];
  await buildImageTuneReport(input, { qualities: [60, 75, 85], onProgress: (event) => events.push(event) });
  expect(events[0]?.phase).toBe("inspect");
  expect(
    events.filter((event) => event.phase === "encode").map(({ current, total }) => [current, total]),
  ).toEqual([
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
  expect(events.at(-1)?.phase).toBe("review");
});
