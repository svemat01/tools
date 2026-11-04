import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverFiles,
  displayPath,
  encodeTextFile,
  nextAvailablePath,
  planOutputPath,
  readTextFile,
  resolvePath,
  writeFileAtomic,
} from "../../src/lib/fs.ts";

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sv-fs-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("nextAvailablePath", () => {
  test("adds numeric suffixes instead of overwriting", async () => {
    const directory = await temporary();
    const target = join(directory, "image.webp");
    await writeFile(target, "one");
    expect(nextAvailablePath(target)).toBe(join(directory, "image-1.webp"));
    await writeFile(join(directory, "image-1.webp"), "two");
    expect(nextAvailablePath(target)).toBe(join(directory, "image-2.webp"));
  });

  test("returns the original path when it does not exist", async () => {
    const directory = await temporary();
    expect(nextAvailablePath(join(directory, "fresh.webp"))).toBe(join(directory, "fresh.webp"));
  });
});

describe("planOutputPath", () => {
  test("changes the extension in the input directory", async () => {
    const directory = await temporary();
    const input = join(directory, "photo.png");
    expect(await planOutputPath({ input, cwd: directory, extension: "webp" })).toBe(
      join(directory, "photo.webp"),
    );
  });

  test("never selects an existing file unless overwrite is true", async () => {
    const directory = await temporary();
    const input = join(directory, "photo.png");
    await writeFile(join(directory, "photo.webp"), "existing");
    expect(await planOutputPath({ input, cwd: directory, extension: "webp" })).toBe(
      join(directory, "photo-1.webp"),
    );
    expect(await planOutputPath({ input, cwd: directory, extension: "webp", overwrite: true })).toBe(
      join(directory, "photo.webp"),
    );
  });

  test("renames a same-format target instead of writing over the input", async () => {
    const directory = await temporary();
    const input = join(directory, "cover.png");
    expect(await planOutputPath({ input, cwd: directory, extension: "png" })).toBe(
      join(directory, "cover-optimized.png"),
    );
  });

  test("honours --out and --out-dir", async () => {
    const directory = await temporary();
    const input = join(directory, "photo.png");
    await mkdir(join(directory, "out"));
    expect(await planOutputPath({ input, cwd: directory, extension: "webp", out: "named.webp" })).toBe(
      join(directory, "named.webp"),
    );
    expect(await planOutputPath({ input, cwd: directory, extension: "webp", outDir: "out" })).toBe(
      join(directory, "out", "photo.webp"),
    );
  });

  test("treats an existing directory passed to --out as a directory", async () => {
    const directory = await temporary();
    const input = join(directory, "photo.png");
    await mkdir(join(directory, "nested"));
    expect(await planOutputPath({ input, cwd: directory, extension: "webp", out: "nested" })).toBe(
      join(directory, "nested", "photo.webp"),
    );
  });
});

describe("writeFileAtomic and text files", () => {
  test("writes bytes through a temporary sibling", async () => {
    const directory = await temporary();
    const path = join(directory, "nested", "file.txt");
    await writeFileAtomic(path, Buffer.from("hello"));
    expect((await readTextFile(path)).text).toBe("hello");
  });

  test("detects and preserves a UTF-8 BOM", async () => {
    const directory = await temporary();
    const path = join(directory, "bom.txt");
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("text")]));
    const file = await readTextFile(path);
    expect(file.bom).toBe(true);
    expect(file.text).toBe("text");
    expect(encodeTextFile(file, "changed")).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("changed")]),
    );
  });
});

describe("discoverFiles", () => {
  test("filters by extension and skips build directories", async () => {
    const directory = await temporary();
    await mkdir(join(directory, "nested"));
    await mkdir(join(directory, "node_modules"));
    await writeFile(join(directory, "a.png"), "a");
    await writeFile(join(directory, "b.txt"), "b");
    await writeFile(join(directory, "nested", "c.png"), "c");
    await writeFile(join(directory, "node_modules", "d.png"), "d");

    const result = await discoverFiles([directory], { cwd: directory, extensions: ["png"] });
    expect(result.files.map((path) => displayPath(directory, path))).toEqual(["a.png", "nested/c.png"]);
    expect(result.missing).toEqual([]);
    expect(result.unsupported).toEqual([]);
  });

  test("reports missing and unsupported paths without throwing", async () => {
    const directory = await temporary();
    await writeFile(join(directory, "notes.md"), "notes");
    const result = await discoverFiles(["missing.png", "notes.md"], {
      cwd: directory,
      extensions: ["png"],
    });
    expect(result.missing).toEqual([join(directory, "missing.png")]);
    expect(result.unsupported).toEqual([join(directory, "notes.md")]);
    expect(result.files).toEqual([]);
  });
});

describe("resolvePath", () => {
  test("resolves relative paths against cwd", () => {
    expect(resolvePath("/work", "images/a.png")).toBe("/work/images/a.png");
  });

  test("expands a leading tilde", () => {
    const home = process.env.HOME ?? "~";
    expect(resolvePath("/work", "~/a.png")).toBe(join(home, "a.png"));
  });
});
