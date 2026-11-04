import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTextFile } from "../../src/lib/fs.ts";
import {
  detectLineEnding,
  fixScans,
  fixText,
  isFixable,
  previewLine,
  scanFile,
  scanPaths,
  scanText,
  UNICODE_RULES,
  unicodeName,
} from "../../src/lib/unicode.ts";

const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sv-unicode-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scanText", () => {
  test("finds invisible characters with 1-based line and column", () => {
    const scan = scanText("hello\u200bworld\nsecond\u00a0line\n");
    expect(
      scan.findings.map((finding) => [finding.line, finding.column, unicodeName(finding.codePoint)]),
    ).toEqual([
      [1, 6, "U+200B"],
      [2, 7, "U+00A0"],
    ]);
    expect(scan.lineEnding).toBe("\n");
  });

  test("handles CRLF without counting the carriage return as a column", () => {
    const scan = scanText("a\r\nb\u200bc\r\n");
    expect(scan.findings).toHaveLength(1);
    expect(scan.findings[0]).toMatchObject({ line: 2, column: 2 });
    expect(scan.lineEnding).toBe("\r\n");
  });

  test("previews dangerous characters without printing them raw", () => {
    const line = "before\u200bafter";
    expect(previewLine(line, 6)).toContain("⟦U+200B⟧");
    expect(previewLine(line, 6)).not.toContain("\u200b");
  });

  test("detects mixed line endings", () => {
    expect(detectLineEnding("a\nb\r\nc")).toBe("mixed");
    expect(detectLineEnding("a\rb")).toBe("\r");
  });
});

describe("fixText", () => {
  test("removes invisible characters by default", () => {
    expect(fixText("a\u200bb\u00a0c")).toEqual({ text: "ab c", replacements: 2 });
  });

  test("leaves typography alone unless explicitly enabled", () => {
    expect(fixText("“quoted” – dash").text).toBe("“quoted” – dash");
    expect(fixText("“quoted” – dash", { typography: true })).toEqual({
      text: '"quoted" - dash',
      replacements: 3,
    });
  });

  test("only marks rules with a replacement as fixable", () => {
    const reportOnly = UNICODE_RULES.get(0x200c)!;
    const removable = UNICODE_RULES.get(0x200b)!;
    expect(isFixable(reportOnly)).toBe(false);
    expect(isFixable(removable)).toBe(true);
  });
});

describe("scanFile and fixScans", () => {
  test("preserves a UTF-8 BOM and CRLF line endings", async () => {
    const directory = await temporary();
    const path = join(directory, "post.md");
    const original = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("a\u200bb\r\nc\r\n", "utf8"),
    ]);
    await writeFile(path, original);

    const scan = await scanFile(path);
    expect(scan.findings).toHaveLength(1);
    const result = await fixScans([scan]);
    expect(result.replacements).toBe(1);
    expect(result.changed).toHaveLength(1);

    const fixed = await readTextFile(path);
    expect(fixed.bom).toBe(true);
    expect(fixed.text).toBe("ab\r\nc\r\n");
    expect(fixed.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  test("dry runs report changes without writing", async () => {
    const directory = await temporary();
    const path = join(directory, "post.md");
    await writeFile(path, "a\u200bb\n");

    const scan = await scanFile(path);
    const result = await fixScans([scan], { dryRun: true });
    expect(result.replacements).toBe(1);
    expect((await readTextFile(path)).text).toBe("a\u200bb\n");
  });

  test("refuses to overwrite a file edited after the scan", async () => {
    const directory = await temporary();
    const path = join(directory, "post.md");
    await writeFile(path, "a\u200bb\n");

    const scan = await scanFile(path);
    await writeFile(path, "changed\n");

    const result = await fixScans([scan]);
    expect(result.changed).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("file changed after scanning");
    expect((await readTextFile(path)).text).toBe("changed\n");
  });
});

describe("scanPaths", () => {
  test("skips binary files and respects the size limit", async () => {
    const directory = await temporary();
    const text = join(directory, "text.md");
    const binary = join(directory, "binary.bin");
    const big = join(directory, "big.md");
    await writeFile(text, "ok\u200b\n");
    await writeFile(binary, Buffer.from([0x00, 0x01, 0x02]));
    await writeFile(big, "x".repeat(64));

    const summary = await scanPaths([directory], { cwd: directory, maxBytes: 32 });
    expect(summary.files.map((file) => file.path)).toEqual([text]);
    expect(summary.skipped.map((entry) => entry.reason).sort()).toEqual([
      "binary file",
      "larger than 32 bytes",
    ]);
    expect(summary.totalFindings).toBe(1);
  });
});
