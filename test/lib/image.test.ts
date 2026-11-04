import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import {
  extensionForFormat,
  formatDimensions,
  IMAGE_EXTENSIONS,
  inspectImage,
  normalizeFormat,
  parseDimensions,
  transformImage,
} from "../../src/lib/image.ts";

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sv-image-"));
  directories.push(directory);
  return directory;
}

async function makeImage(directory: string, name: string, width: number, height: number): Promise<string> {
  const path = join(directory, name);
  await sharp({
    create: { width, height, channels: 4, background: { r: 10, g: 120, b: 200, alpha: 1 } },
  })
    .png()
    .toFile(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("inspectImage", () => {
  test("reads dimensions, format and size", async () => {
    const directory = await temporary();
    const path = await makeImage(directory, "sample.png", 320, 200);
    const info = await inspectImage(path);
    expect(info).toMatchObject({
      width: 320,
      height: 200,
      format: "png",
      animated: false,
      pages: 1,
    });
    expect(info.bytes).toBeGreaterThan(0);
  });
});

describe("transformImage", () => {
  test("resizes down and preserves aspect ratio", async () => {
    const directory = await temporary();
    const path = await makeImage(directory, "large.png", 800, 400);
    const result = await transformImage(path, {
      resize: { width: 200, withoutEnlargement: true },
      encode: { format: "webp", quality: 80 },
    });
    expect(result).toMatchObject({ width: 200, height: 100, format: "webp" });
    expect(result.bytes).toBe(result.data.length);
  });

  test("does not upscale by default", async () => {
    const directory = await temporary();
    const path = await makeImage(directory, "small.png", 400, 300);
    const result = await transformImage(path, {
      resize: { width: 800, withoutEnlargement: true },
      encode: { format: "webp" },
    });
    expect(result).toMatchObject({ width: 400, height: 300 });
  });

  test("keeps PNG output as PNG when asked", async () => {
    const directory = await temporary();
    const path = await makeImage(directory, "cover.png", 1200, 630);
    const result = await transformImage(path, {
      encode: { format: "png", palette: true, quality: 85 },
    });
    expect(result.format).toBe("png");
    expect(result.width).toBe(1200);
    expect(result.height).toBe(630);
    expect((await sharp(result.data).metadata()).format).toBe("png");
  });
});

describe("format helpers", () => {
  test("parses common dimension syntaxes", () => {
    expect(parseDimensions("1920x1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseDimensions("1920X1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseDimensions("1920×1080")).toEqual({ width: 1920, height: 1080 });
  });

  test("rejects invalid dimensions", () => {
    expect(() => parseDimensions("wide")).toThrow("Invalid dimensions");
    expect(() => parseDimensions("0x10")).toThrow("positive integers");
  });

  test("normalizes format names and extensions", () => {
    expect(normalizeFormat("jpg")).toBe("jpeg");
    expect(normalizeFormat("TIFF")).toBe("tiff");
    expect(normalizeFormat("heic")).toBeUndefined();
    expect(extensionForFormat("jpeg")).toBe("jpg");
    expect(extensionForFormat("webp")).toBe("webp");
    expect(formatDimensions(1920, 1080)).toBe("1920×1080");
  });

  test("lists supported input extensions", () => {
    expect(IMAGE_EXTENSIONS).toContain("png");
    expect(IMAGE_EXTENSIONS).toContain("avif");
    expect(IMAGE_EXTENSIONS).toContain("svg");
  });
});
