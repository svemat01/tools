/**
 * Real shells completing a real CLI: the generated (patched) scripts, the
 * `complete --` protocol and the kit's directives, end to end.
 *
 * zsh runs through a zpty-driven interactive shell; bash calls the registered
 * completion function directly. Each suite skips when its shell is missing
 * (bash needs >= 4 and bash-completion; CI installs both).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixtureApp } from "./fixtures/app.ts";
import { bashAvailable, completeBash } from "./support/shell/bash.ts";
import { completeZsh, zshAvailable } from "./support/shell/zsh.ts";

let dir = "";
let cli = "";
let argvLog = "";
let files = "";
const app = fixtureApp();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sv-shell-"));
  cli = join(dir, "fx");
  argvLog = join(dir, "argv");
  const main = join(import.meta.dir, "fixtures", "main.ts");
  // Log the exact argv the shell passes, then run the real fixture CLI.
  await Bun.write(
    cli,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvLog}'\nexec '${process.execPath}' '${main}' "$@"\n`,
  );
  chmodSync(cli, 0o755);
  files = join(dir, "files");
  mkdirSync(join(files, "sub dir"), { recursive: true });
  for (const file of ["a.png", "b.jpg", "c.txt", "my file.png", "sub dir/x.png"]) {
    await Bun.write(join(files, file), "");
  }
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** argv of the last `fx` invocation, minus the trailing newline. */
function receivedArgv(): string[] {
  return readFileSync(argvLog, "utf8").split("\n").slice(0, -1);
}

describe.skipIf(!zshAvailable())("zsh", () => {
  const zsh = (line: string) =>
    completeZsh({ script: app.script("zsh"), commandName: "fx", commandPath: cli, line, cwd: files });

  test("nested commands and insertion", async () => {
    expect((await zsh("fx alpha ")).candidates).toEqual(["beta"]);
    expect((await zsh("fx al")).buffer).toBe("fx alpha ");
    expect((await zsh("fx alpha beta ga")).buffer).toBe("fx alpha beta gamma ");
  });

  test("option values: space form, = form, short alias, with descriptions", async () => {
    const spaced = await zsh("fx alpha beta gamma --mode ");
    expect(spaced.candidates).toEqual(["fast", "slow"]);
    expect(spaced.matches.map((match) => match.description)).toEqual(["Go fast", "Go slow"]);
    expect((await zsh("fx alpha beta gamma --mode=")).candidates).toEqual(["--mode=fast", "--mode=slow"]);
    expect((await zsh("fx alpha beta gamma -m s")).buffer).toBe("fx alpha beta gamma -m slow ");
  });

  test("parent and child options with the same name", async () => {
    expect((await zsh("fx --name ")).candidates.toSorted()).toEqual(["root-a", "root-b"]);
    expect((await zsh("fx alpha --name ")).candidates).toEqual(["alpha-a"]);
    expect((await zsh("fx alpha beta gamma --name ")).candidates).toEqual(["gamma-a"]);
  });

  test("files filtered by extension; directories stay traversable", async () => {
    expect((await zsh("fx files ")).candidates.toSorted()).toEqual([
      "a.png",
      "b.jpg",
      "my file.png",
      "sub dir/",
    ]);
    expect((await zsh("fx files my")).buffer).toBe("fx files my\\ file.png ");
    expect((await zsh("fx files sub\\ dir/")).buffer).toBe("fx files sub\\ dir/x.png ");
  });

  test("directories only, and unfiltered files", async () => {
    expect((await zsh("fx files --dir ")).candidates).toEqual(["sub dir/"]);
    expect((await zsh("fx files --any ")).candidates.toSorted()).toEqual([
      "a.png",
      "b.jpg",
      "c.txt",
      "my file.png",
      "sub dir/",
    ]);
  });

  test("no path completion unless asked for", async () => {
    expect((await zsh("fx alpha beta gamma --name zz")).candidates).toEqual([]);
  });

  test("the CLI receives the words the user meant (fixed in scripts.ts)", async () => {
    await zsh("fx files my\\ file.png --any ");
    expect(receivedArgv()).toEqual(["complete", "--", "files", "my file.png", "--any", ""]);
    await zsh("fx files 'my file.png' --any ");
    expect(receivedArgv()).toEqual(["complete", "--", "files", "my file.png", "--any", ""]);
  });

  test("typed command substitutions are not executed on TAB (fixed in scripts.ts)", async () => {
    await zsh("fx files $(touch PWNED) ");
    expect(existsSync(join(files, "PWNED"))).toBe(false);
    expect(receivedArgv()).toEqual(["complete", "--", "files", "$(touch PWNED)", ""]);
  });

  test("values containing a colon stay whole (fixed in scripts.ts)", async () => {
    const result = await zsh("fx shaped --first ");
    expect(result.candidates).toEqual(["key:value", "plain"]);
  });
});

const bash = bashAvailable();

describe.skipIf(!bash.ok)(`bash${bash.ok ? "" : ` (skipped: ${bash.reason})`}`, () => {
  const complete = (line: string) =>
    completeBash({ script: app.script("bash"), commandName: "fx", commandPath: cli, line, cwd: files });

  test("nested commands and option values", async () => {
    expect((await complete("fx alpha ")).candidates).toEqual(["beta"]);
    expect((await complete("fx alpha beta gamma --mode ")).candidates).toEqual(["fast", "slow"]);
    expect((await complete("fx --name ")).candidates).toEqual(["root-a", "root-b"]);
  });

  test("--opt=value completes the value part (fixed in scripts.ts)", async () => {
    expect((await complete("fx alpha beta gamma --mode=")).candidates).toEqual(["fast", "slow"]);
    expect((await complete("fx alpha beta gamma --mode=s")).candidates).toEqual(["slow"]);
  });

  test("files filtered by extension, including directories and spaces (fixed in scripts.ts)", async () => {
    expect((await complete("fx files ")).candidates.toSorted()).toEqual([
      "a.png",
      "b.jpg",
      "my file.png",
      "sub dir",
    ]);
  });

  test("directories keep their spaces (fixed in scripts.ts)", async () => {
    expect((await complete("fx files --dir ")).candidates).toEqual(["sub dir"]);
  });

  test("unfiltered files fall back to readline's default completion (fixed in scripts.ts)", async () => {
    const result = await complete("fx files --any ");
    expect(result.candidates).toEqual([]);
    expect(result.fallsBackToDefault).toBe(true);
  });

  test("NoFileComp turns the fallback off", async () => {
    const result = await complete("fx alpha beta gamma --name zz");
    expect(result.candidates).toEqual([]);
    expect(result.compopt).toContainEqual("+o default");
  });
});
