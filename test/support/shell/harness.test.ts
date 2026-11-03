// Self-tests for the shell completion harnesses, using Tab's generated scripts
// and a fake CLI that prints canned `complete --` output ($FAKE_OUT).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RootCommand } from "@bomb.sh/tab";

import { bashAvailable, completeBash, splitCompWords } from "./bash.ts";
import { completeZsh, zshAvailable } from "./zsh.ts";

let dir = "";
let cli = "";

/** Tab's setup() prints the script; capture it. */
function tabScript(shell: "zsh" | "bash", exec: string): string {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    new RootCommand().setup("fake", exec, shell);
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "shell-harness-"));
  cli = join(dir, "fake-cli");
  await Bun.write(cli, `#!/bin/sh\nprintf '%s' "$FAKE_OUT"\n`);
  chmodSync(cli, 0o755);
  mkdirSync(join(dir, "files", "sub dir"), { recursive: true });
  for (const f of ["a.png", "b.jpg", "my file.png", "sub dir/c.png"])
    await Bun.write(join(dir, "files", f), "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!zshAvailable())("completeZsh", () => {
  const run = (line: string, out: string) =>
    completeZsh({
      script: tabScript("zsh", "fake"),
      commandName: "fake",
      commandPath: cli,
      line,
      cwd: join(dir, "files"),
      env: { FAKE_OUT: out },
    });

  test("captures _describe candidates and descriptions", async () => {
    const r = await run("fake ", "media\tMedia tools\nconfig\tConfiguration\n:4\n");
    expect(r.candidates).toEqual(["media", "config"]);
    expect(r.matches.map((m) => m.description)).toEqual(["Media tools", "Configuration"]);
  });

  test("single match is inserted", async () => {
    const r = await run("fake me", "media\tMedia tools\n:4\n");
    expect(r.buffer).toBe("fake media ");
  });

  test("NoFileComp with no candidates offers nothing", async () => {
    expect((await run("fake x ", ":4\n")).candidates).toEqual([]);
  });

  test("default directive falls back to files; dirs get a slash", async () => {
    const r = await run("fake x ", ":0\n");
    expect(r.candidates.toSorted()).toEqual(["a.png", "b.jpg", "my file.png", "sub dir/"]);
    expect(r.insertions).toContain("my\\ file.png");
    expect((await run("fake x sub\\ dir/", ":0\n")).buffer).toBe("fake x sub\\ dir/c.png ");
  });
});

describe("splitCompWords", () => {
  test.each([
    ["demo ", ["demo", ""], 1],
    ["demo media web --format=", ["demo", "media", "web", "--format", "="], 4],
    ["demo --format=w", ["demo", "--format", "=", "w"], 3],
    ["demo my\\ file.png ", ["demo", "my\\ file.png", ""], 2],
    ["demo 'my fi", ["demo", "'my fi"], 1],
    ["", [""], 0],
  ] as const)("%j", (line, words, cword) => {
    expect(splitCompWords(line)).toEqual({ words: [...words], cword });
  });
});

describe.skipIf(!bashAvailable().ok)("completeBash", () => {
  test("captures COMPREPLY", async () => {
    const r = await completeBash({
      script: tabScript("bash", "fake"),
      commandName: "fake",
      commandPath: cli,
      line: "fake m",
      env: { FAKE_OUT: "media\tMedia tools\nconfig\tConfiguration\n:4\n" },
    });
    expect(r.candidates).toEqual(["media"]);
    expect(r.compopt).toContain("+o default");
  });
});
