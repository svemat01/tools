import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { name, route } from "@bomb.sh/router";

import { watch } from "../src/commands/watch.ts";
import { createApp } from "../src/kit/index.ts";
import { runCommand } from "../src/lib/process.ts";
import { watchReady } from "../src/lib/watch.ts";
import { capture, runApp } from "./support/io.ts";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sv-watch-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "note.md"), "# Note\n\nHello\n");
  return { cwd, env: { PATH: process.env.PATH, XDG_STATE_HOME: join(root, "state") } };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const app = createApp(route(name("sv"), watch), {
  context: (base) => ({
    ...base,
    log: { info() {}, debug() {} },
    readStdin: async () => "",
    confirm: async () => {
      throw new Error("watch must never confirm");
    },
  }),
});

async function git(cwd: string, ...args: string[]) {
  const result = await runCommand("git", args, {
    cwd,
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  expect(result.code).toBe(0);
}

test("watch once validates without writes and emits one bounded JSON check", async () => {
  const options = await fixture();
  const before = await readdir(options.cwd);
  const result = await runApp(app, ["watch", ".", "--once", "--json"], options);
  expect(result.code).toBe(0);
  const event = JSON.parse(result.stdout);
  expect(event).toMatchObject({
    command: "watch",
    schemaVersion: 1,
    event: "check",
    reason: "initial",
    sequence: 1,
    status: "noop",
    checks: { errors: 0 },
    summary: { files: 1 },
  });
  expect(event).not.toHaveProperty("operations");
  expect(event).not.toHaveProperty("options");
  expect(event).not.toHaveProperty("sources");
  expect(await readdir(options.cwd)).toEqual(before);
  expect(await readdir(join(options.cwd, ".."))).toEqual(["project"]);
  expect(await readFile(join(options.cwd, "note.md"), "utf8")).toBe("# Note\n\nHello\n");
});

test("once failures are actionable; invalid interval is usage error", async () => {
  const options = await fixture();
  await writeFile(join(options.cwd, "note.md"), "[broken](missing.md)\n");
  const broken = await runApp(app, ["watch", "note.md", "--once", "--json"], options);
  expect(broken.code).toBe(1);
  expect(JSON.parse(broken.stdout)).toMatchObject({ status: "blocked", checks: { errors: 1 } });
  const missing = await runApp(app, ["watch", "absent.md", "--once"], options);
  expect(missing.code).toBe(1);
  expect(missing.stdout).toContain("absent.md");
  expect((await runApp(app, ["watch", "--interval", "0", "--once"], options)).code).toBe(2);
  expect((await runApp(app, ["watch", "--apply", "--once"], options)).code).toBe(2);
});

test("metadata polling coalesces unchanged inputs, sees edits/additions/deletions and cancels promptly", async () => {
  const options = await fixture();
  const controller = new AbortController();
  const events = watchReady(["."], { ...options, intervalMs: 100, signal: controller.signal });
  expect((await events.next()).value?.sequence).toBe(1);
  let resolved = false;
  const next = events.next().then((value) => {
    resolved = true;
    return value;
  });
  await new Promise((done) => setTimeout(done, 250));
  expect(resolved).toBe(false);
  await writeFile(join(options.cwd, "note.md"), "# Note\n\nEdited\n");
  expect((await next).value).toMatchObject({ reason: "change", sequence: 2 });
  await writeFile(join(options.cwd, "new.md"), "# New\n");
  expect((await events.next()).value?.summary.files).toBe(2);
  await rm(join(options.cwd, "new.md"));
  expect((await events.next()).value?.summary.files).toBe(1);
  const stopped = events.next();
  controller.abort();
  expect((await stopped).done).toBe(true);
});

test("watch notices hidden project config changes and ignores generated output edits", async () => {
  const options = await fixture();
  await mkdir(join(options.cwd, ".sv"));
  await writeFile(join(options.cwd, ".sv", "blog.json"), '{"requiredMetadata":[]}');
  await mkdir(join(options.cwd, ".sv-ready"));
  await writeFile(join(options.cwd, ".sv-ready", "generated.md"), "first");
  const controller = new AbortController();
  const events = watchReady(["."], { ...options, intervalMs: 100, signal: controller.signal });
  expect((await events.next()).value?.status).toBe("noop");
  await writeFile(join(options.cwd, ".sv-ready", "generated.md"), "changed");
  let resolved = false;
  const next = events.next().then((value) => {
    resolved = true;
    return value;
  });
  await new Promise((done) => setTimeout(done, 250));
  expect(resolved).toBe(false);
  await writeFile(join(options.cwd, ".sv", "blog.json"), '{"requiredMetadata":["title"]}');
  expect((await next).value).toMatchObject({ status: "blocked", reason: "change" });
  const stopped = events.next();
  controller.abort();
  await stopped;
});

test("changed selection reacts when files become tracked, staged or clean without mutations", async () => {
  const options = await fixture();
  await git(options.cwd, "init", "-q");
  const controller = new AbortController();
  const events = watchReady(["."], { ...options, changed: true, intervalMs: 100, signal: controller.signal });
  expect((await events.next()).value?.summary.files).toBe(1);
  await git(options.cwd, "add", "--", "note.md");
  await git(
    options.cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  expect((await events.next()).value?.summary.files).toBe(0);
  await writeFile(join(options.cwd, "note.md"), "# Note\nChanged\n");
  await git(options.cwd, "add", "--", "note.md");
  expect((await events.next()).value?.summary.files).toBe(1);
  const stopped = events.next();
  controller.abort();
  await stopped;
});

test("continuous CLI emits NDJSON and returns cleanly on cancellation even after a failing check", async () => {
  const options = await fixture();
  await writeFile(join(options.cwd, "note.md"), "[bad](missing.md)\n");
  const controller = new AbortController();
  let output = "";
  const code = await app.run(["watch", "note.md", "--json", "--interval", "100"], {
    ...options,
    signal: controller.signal,
    stderr: capture(),
    stdout: {
      write(chunk) {
        output += chunk;
        controller.abort();
      },
    },
  });
  expect(code).toBe(0);
  expect(output.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(output).status).toBe("blocked");
  expect(await readdir(join(options.cwd, ".."))).toEqual(["project"]);
});

test("watch reports discovery bounds without creating state or processing oversized selections", async () => {
  const options = await fixture();
  for (let index = 0; index < 200; index++)
    await writeFile(join(options.cwd, `extra-${index}.txt`), "fixture");
  const result = await runApp(app, ["watch", ".", "--once", "--json"], options);
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    event: "error",
    status: "blocked",
    failures: [expect.stringContaining("200 files")],
  });
  expect(await readdir(join(options.cwd, ".."))).toEqual(["project"]);
});
