import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { app } from "../src/app.ts";
import { capture, runApp } from "./support/io.ts";

const directories: string[] = [];

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sv-media-commands-"));
  directories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function image(root: string, name: string): Promise<string> {
  const data = Buffer.alloc(32 * 32 * 3);
  for (let index = 0; index < data.length; index++) data[index] = (index * 17 + Math.floor(index / 71)) % 256;
  const path = join(root, name);
  await sharp(data, { raw: { width: 32, height: 32, channels: 3 } })
    .png()
    .toFile(path);
  return path;
}

describe("media command integration", () => {
  test("img compare resolves inputs and outputs against --cwd", async () => {
    const root = await temporary();
    await image(root, "before.png");
    await image(root, "after.png");
    const result = await runApp(app, ["--cwd", root, "img", "compare", "before.png", "after.png", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      before: "before.png",
      after: "after.png",
      diffPixels: 0,
    });
    expect(await Bun.file(join(root, "after-diff.png")).exists()).toBe(true);
  });

  test("img og preserves PNG pixel values by default", async () => {
    const root = await temporary();
    const input = await image(root, "input.png");
    const result = await runApp(app, ["img", "og", "input.png", "--target", "32x32", "--json"], {
      cwd: root,
    });
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout).files[0].output as string;
    expect(await sharp(join(root, output)).raw().toBuffer()).toEqual(await sharp(input).raw().toBuffer());
    expect((await sharp(join(root, output)).metadata()).isPalette).toBe(false);
  });

  test("img web preserves same-format bytes unless recompression is requested", async () => {
    const root = await temporary();
    const source = await image(root, "input.png");
    await sharp(source).webp({ lossless: true }).toFile(join(root, "input.webp"));
    const original = await readFile(join(root, "input.webp"));
    const skipped = await runApp(app, ["img", "web", "input.webp", "--json"], { cwd: root });
    expect(skipped.code).toBe(0);
    expect(JSON.parse(skipped.stdout).files[0].skipped).toBe(true);

    const copied = await runApp(app, ["img", "web", "input.webp", "--out", "copy.webp", "--json"], {
      cwd: root,
    });
    expect(copied.code).toBe(0);
    expect(await readFile(join(root, "copy.webp"))).toEqual(original);

    const encoded = await runApp(
      app,
      ["img", "web", "input.webp", "--quality", "10", "--out", "small.webp", "--json"],
      { cwd: root },
    );
    expect(encoded.code).toBe(0);
    expect(JSON.parse(encoded.stdout).files[0].skipped).toBe(false);
    expect(await readFile(join(root, "small.webp"))).not.toEqual(original);
    expect(await readFile(join(root, "input.webp"))).toEqual(original);

    const reencoded = await runApp(
      app,
      ["img", "web", "input.webp", "--reencode", "--out", "reencoded.webp", "--json"],
      { cwd: root },
    );
    expect(reencoded.code).toBe(0);
    expect(await readFile(join(root, "reencoded.webp"))).not.toEqual(original);
  });

  test("batch dry-run and actual writes agree on colliding basenames", async () => {
    const root = await temporary();
    await mkdir(join(root, "one"));
    await mkdir(join(root, "two"));
    await image(join(root, "one"), "photo.png");
    await image(join(root, "two"), "photo.png");
    const args = ["img", "web", "one/photo.png", "two/photo.png", "--out-dir", "output", "--json"];
    const preview = await runApp(app, [...args, "--dry-run"], { cwd: root });
    expect(preview.code).toBe(0);
    const planned = JSON.parse(preview.stdout).files.map((file: { output: string }) => file.output);
    expect(planned).toEqual(["output/photo.webp", "output/photo-1.webp"]);
    const applied = await runApp(app, args, { cwd: root });
    expect(applied.code).toBe(0);
    expect(JSON.parse(applied.stdout).files.map((file: { output: string }) => file.output)).toEqual(planned);
  });

  test("tunnel forwards --host and emits JSON while the process is running", async () => {
    const root = await temporary();
    const argumentsFile = join(root, "arguments.json");
    const binary = join(root, "cloudflared");
    await writeFile(
      binary,
      `#!${process.execPath}
await Bun.write(process.env.SV_ARGUMENTS_FILE, JSON.stringify(process.argv.slice(2)));
console.log("https://test-ready.trycloudflare.com");
setInterval(() => {}, 1000);
`,
    );
    await chmod(binary, 0o755);
    const controller = new AbortController();
    const stderr = capture();
    let ready: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let output = "";
    let finished = false;
    const running = app
      .run(["tunnel", "8080", "--host", "127.0.0.2", "--json"], {
        cwd: root,
        env: { PATH: root, SV_ARGUMENTS_FILE: argumentsFile },
        signal: controller.signal,
        stderr,
        stdout: {
          write(chunk) {
            output += chunk;
            ready?.();
          },
        },
      })
      .then((code) => {
        finished = true;
        return code;
      });
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      await Promise.race([
        started,
        running.then(() => {
          throw new Error(`Tunnel exited before ready: ${stderr.text}`);
        }),
      ]);
      expect(finished).toBe(false);
      expect(JSON.parse(output)).toEqual({ url: "https://test-ready.trycloudflare.com" });
      expect(JSON.parse(await readFile(argumentsFile, "utf8"))).toContain("http://127.0.0.2:8080");
      expect(stderr.text).toContain("http://127.0.0.2:8080");
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await running;
    }
    expect(output.trim().split("\n")).toHaveLength(1);
  });

  test("an already cancelled tunnel does not launch a process", async () => {
    const root = await temporary();
    const result = await runApp(app, ["tunnel", "--json"], {
      cwd: root,
      signal: AbortSignal.abort(),
      env: { PATH: root },
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("cloudflared is required");
  });

  test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
    "video webm encodes a playable file within an odd width limit",
    async () => {
      const root = await temporary();
      await image(root, "frame.png");
      const fixture = Bun.spawn(
        [
          "ffmpeg",
          "-v",
          "error",
          "-loop",
          "1",
          "-i",
          join(root, "frame.png"),
          "-t",
          "0.2",
          "-c:v",
          "ffv1",
          join(root, "source.mkv"),
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const fixtureErrors = await new Response(fixture.stderr).text();
      expect(await fixture.exited, fixtureErrors).toBe(0);
      const result = await runApp(
        app,
        ["video", "webm", "source.mkv", "--width", "25", "--audio", "strip", "--json"],
        {
          cwd: root,
          env: { PATH: process.env.PATH },
        },
      );
      expect(result.code, result.stderr).toBe(0);
      const probe = Bun.spawn(
        ["ffprobe", "-v", "error", "-show_streams", "-print_format", "json", join(root, "source.webm")],
        { stdout: "pipe", stderr: "pipe" },
      );
      const info = JSON.parse(await new Response(probe.stdout).text());
      expect(await probe.exited).toBe(0);
      expect(info.streams[0]).toMatchObject({ codec_name: "vp9", width: 24, height: 24 });
      const decode = Bun.spawn(
        ["ffmpeg", "-v", "error", "-i", join(root, "source.webm"), "-f", "null", "-"],
        { stdout: "ignore", stderr: "pipe" },
      );
      const decodeErrors = await new Response(decode.stderr).text();
      expect(await decode.exited, decodeErrors).toBe(0);
      expect(await Bun.file(join(root, "source.mkv")).exists()).toBe(true);
    },
    10000,
  );
});

test("AVIF is recognized for info, same-format preservation and resizing", async () => {
  const root = await temporary();
  const input = join(root, "source.avif");
  await sharp({ create: { width: 16, height: 12, channels: 3, background: "red" } })
    .avif()
    .toFile(input);
  const original = await readFile(input);
  const info = await runApp(app, ["img", "info", input, "--json"], { cwd: root });
  expect(JSON.parse(info.stdout).files[0].format).toBe("avif");
  const skipped = await runApp(app, ["img", "web", input, "--format", "avif", "--json"], { cwd: root });
  expect(skipped.code).toBe(0);
  expect(JSON.parse(skipped.stdout).files[0].skipped).toBe(true);
  expect(await readFile(input)).toEqual(original);
  const resized = await runApp(app, ["img", "resize", input, "--width", "8", "--json"], { cwd: root });
  expect(resized.code).toBe(0);
  const output = join(root, JSON.parse(resized.stdout).files[0].output);
  expect(await sharp(output).metadata()).toMatchObject({ width: 8, compression: "av1" });
});

test("web width limits follow display orientation, and visual comparison auto-orients", async () => {
  const root = await temporary();
  const rotated = join(root, "rotated.webp");
  await sharp({ create: { width: 16, height: 32, channels: 3, background: "red" } })
    .webp()
    .withMetadata({ orientation: 6 })
    .toFile(rotated);
  const web = await runApp(app, ["img", "web", rotated, "--width", "20", "--json"], { cwd: root });
  expect(web.code).toBe(0);
  expect(JSON.parse(web.stdout).files[0]).toMatchObject({ skipped: false, width: 20, height: 10 });
  const narrow = join(root, "narrow.webp");
  await sharp({ create: { width: 32, height: 16, channels: 3, background: "red" } })
    .webp()
    .withMetadata({ orientation: 6 })
    .toFile(narrow);
  const kept = await runApp(app, ["img", "web", narrow, "--width", "20", "--json"], { cwd: root });
  expect(JSON.parse(kept.stdout).files[0]).toMatchObject({ skipped: true, width: 16, height: 32 });
  const normal = join(root, "normal.png"),
    turned = join(root, "turned.png");
  await sharp({ create: { width: 16, height: 32, channels: 3, background: "blue" } })
    .png()
    .toFile(normal);
  await sharp(normal).withMetadata({ orientation: 6 }).toFile(turned);
  const compared = await runApp(app, ["img", "compare", normal, turned, "--json"], { cwd: root });
  expect(compared.code).toBe(1);
  expect(compared.stderr).toContain("Image dimensions differ");
});
