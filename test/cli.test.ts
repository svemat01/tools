/**
 * End-to-end: spawn the real `sv` entry point as a separate process.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import pkg from "../package.json" with { type: "json" };

const main = join(import.meta.dir, "..", "src", "main.ts");

async function sv(args: readonly string[], options: { cwd?: string } = {}) {
  const child = Bun.spawn([process.execPath, main, ...args], {
    cwd: options.cwd ?? join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

describe("sv", () => {
  test("bare sv prints an overview", async () => {
    const result = await sv([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`sv ${pkg.version}`);
    expect(result.stdout).toContain("media");
    expect(result.stdout).toContain("dev");
  });

  test("--version", async () => {
    expect(await sv(["--version"])).toEqual({ code: 0, stdout: `sv ${pkg.version}\n`, stderr: "" });
  });

  test("nested command with parent and child options of the same name", async () => {
    const group = await sv(["media", "--quality", "40", "web", "cat.png"]);
    expect(group).toEqual({
      code: 0,
      stdout: "would convert cat.png -> cat.webp (webp, quality 40)\n",
      stderr: "",
    });
    const own = await sv([
      "media",
      "--quality",
      "40",
      "web",
      "cat.png",
      "--quality",
      "90",
      "--format",
      "avif",
    ]);
    expect(own.stdout).toBe("would convert cat.png -> cat.avif (avif, quality 90)\n");
  });

  test("root options configure the application context", async () => {
    const result = await sv(["--verbose", "media", "web", "cat.png", "-o", "out.webp"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("debug: quality 80 from sv media --quality\n");
    expect(result.stdout).toBe("would convert cat.png -> out.webp (webp, quality 80)\n");
  });

  test("--cwd changes where commands resolve paths", async () => {
    const result = await sv(["--cwd", "src", "media", "inspect", "main.ts", "missing.ts"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^main\.ts\t\d+ bytes\n$/);
    expect(result.stderr).toBe("missing.ts: not found\n");
  });

  test("executable group and its child", async () => {
    expect(JSON.parse((await sv(["dev", "--json"])).stdout)).toMatchObject({
      program: "sv",
      bun: Bun.version,
    });
    expect(await sv(["dev", "echo", "a", "b", "--upper", "--repeat", "2"])).toEqual({
      code: 0,
      stdout: "A B\nA B\n",
      stderr: "",
    });
  });

  test("usage errors exit with 2 and explain themselves", async () => {
    const misplaced = await sv(["media", "web", "cat.png", "--verbose"]);
    expect(misplaced.code).toBe(2);
    expect(misplaced.stderr).toBe(
      "unexpected: `--verbose`\nhint: --verbose is an option of `sv`; put it before `media`\nRun `sv media web --help` for usage.\n",
    );
    const invalid = await sv(["media", "--quality", "500", "web", "x.png"]);
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain("quality:");
    const group = await sv(["media"]);
    expect(group.code).toBe(2);
    expect(group.stderr).toContain("Commands:\n  web");
  });

  test("completion protocol", async () => {
    expect(await sv(["complete", "--", "media", ""])).toEqual({
      code: 0,
      stdout:
        "web\tConvert an image for the web (stub: prints the plan)\ninspect\tPrint the size of one or more files\n:4\n",
      stderr: "",
    });
    expect((await sv(["complete", "--", "media", "web", "--format", ""])).stdout).toBe(
      "webp\tBroad support\navif\tSmaller, slower to encode\n:4\n",
    );
    expect((await sv(["complete", "--", "media", "web", ""])).stdout).toBe(
      "png\njpg\njpeg\ngif\nwebp\navif\n:8\n",
    );
    expect((await sv(["complete", "--", "--cwd", ""])).stdout).toBe(":16\n");
  });

  test("completion scripts", async () => {
    const zsh = await sv(["complete", "zsh"]);
    expect(zsh.code).toBe(0);
    expect(zsh.stdout).toStartWith("#compdef sv\n");
    expect(zsh.stdout).toContain("sv complete --");
    const bash = await sv(["complete", "bash"]);
    expect(bash.stdout).toContain("complete -o default -F __sv_complete sv");
  });
});
