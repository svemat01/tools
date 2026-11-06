import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sv } from "../src/app.ts";
import { createContext } from "../src/context.ts";
import { createApp } from "../src/kit/index.ts";
import { capture, runApp } from "./support/io.ts";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sv-gremlins-command-"));
  directories.push(directory);
  const path = join(directory, "script.sh");
  await writeFile(path, "#!/bin/sh\necho a\u200bb\n");
  return { directory, path };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test("gremlins reports missing targets as failures in human and JSON output", async () => {
  const { directory } = await fixture();
  const app = createApp(sv, { context: createContext });
  for (const extra of [[], ["--json"]]) {
    const result = await runApp(app, ["gremlins", "absent.txt", ...extra], { cwd: directory });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("path not found");
    expect(result.stdout).not.toContain("No gremlins found");
    if (extra.length) expect(JSON.parse(result.stdout).errors).toHaveLength(1);
  }
});

test("gremlins previews changes before confirmation and preserves executable mode", async () => {
  const { directory, path } = await fixture();
  await chmod(path, 0o755);
  const stdout = capture();
  let confirmed = false;
  const app = createApp(sv, {
    context(base, intent) {
      return {
        ...createContext(base, intent),
        async confirm() {
          confirmed = true;
          expect(stdout.text).toContain("U+200B");
          expect(stdout.text).toContain("fix script.sh:2:7");
          expect(readFileSync(path, "utf8")).toContain("\u200b");
          return true;
        },
      };
    },
  });
  const result = await runApp(app, ["gremlins", "script.sh", "--fix"], { cwd: directory, stdout });
  expect(result.code).toBe(0);
  expect(confirmed).toBe(true);
  expect(await readFile(path, "utf8")).toBe("#!/bin/sh\necho ab\n");
  expect((await stat(path)).mode & 0o777).toBe(0o755);
});

test("gremlins does not apply changes after cancellation during confirmation", async () => {
  const { directory, path } = await fixture();
  const controller = new AbortController();
  const app = createApp(sv, {
    context(base, intent) {
      return {
        ...createContext(base, intent),
        async confirm() {
          controller.abort();
          return true;
        },
      };
    },
  });
  const result = await runApp(app, ["gremlins", "script.sh", "--fix", "--json"], {
    cwd: directory,
    signal: controller.signal,
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).aborted).toBe(true);
  expect(await readFile(path, "utf8")).toContain("\u200b");
});

test("dry-run reports findings remaining and never writes", async () => {
  const { directory, path } = await fixture();
  const app = createApp(sv, { context: createContext });
  const result = await runApp(app, ["gremlins", "script.sh", "--fix", "--dry-run", "--json"], {
    cwd: directory,
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ remaining: 1, fix: { replacements: 1, dryRun: true } });
  expect(await readFile(path, "utf8")).toContain("\u200b");
});
