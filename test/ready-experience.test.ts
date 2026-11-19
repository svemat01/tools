import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import { app, sv } from "../src/app.ts";
import { createContext } from "../src/context.ts";
import { createApp } from "../src/kit/index.ts";
import { readHistory } from "../src/lib/operations.ts";
import { runApp } from "./support/io.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "sv-ready-experience-"));
  roots.push(cwd);
  await sharp({ create: { width: 24, height: 12, channels: 3, background: "red" } })
    .png()
    .toFile(join(cwd, "photo.png"));
  return { cwd, env: { PATH: "/nonexistent", XDG_STATE_HOME: join(cwd, "state") } };
}

test("repeated CLI preparation reports verified reuse without duplicate files or a new receipt", async () => {
  const options = await fixture();
  const args = ["ready", "photo.png", "--review", "--yes", "--json"];
  const first = await runApp(app, args, options);
  expect(first.code).toBe(0);
  const created = JSON.parse(first.stdout);
  expect(created.status).toBe("applied");
  const names = await readdir(join(options.cwd, ".sv-ready"));
  const repeated = await runApp(app, args, options);
  expect(repeated.code).toBe(0);
  const reused = JSON.parse(repeated.stdout);
  expect(reused).toMatchObject({
    status: "reused",
    actions: [],
    summary: { outputs: 0, reusedOutputs: 2, appliedOutputs: 0 },
  });
  expect(reused.reused).toHaveLength(2);
  expect(reused).not.toHaveProperty("recordId");
  expect(await readHistory(options)).toHaveLength(1);
  expect(await readdir(join(options.cwd, ".sv-ready"))).toEqual(names);
  const human = await runApp(app, ["ready", "photo.png", "--review"], options);
  expect(human.stdout).toContain("Already prepared: 1 image");
  expect(human.stdout).toContain("2 verified outputs reused");
  expect(human.stdout).toContain("file:");
  expect(await readHistory(options)).toHaveLength(1);
});

test("TTY progress precedes final preview while JSON and redirected output have no transient controls", async () => {
  const options = await fixture();
  let stderr = "";
  const tty = {
    isTTY: true,
    write(chunk: string) {
      stderr += chunk;
    },
  };
  expect((await runApp(app, ["ready", "photo.png"], { ...options, stderr: tty })).code).toBe(0);
  expect(stderr.indexOf("Encoding")).toBeLessThan(stderr.indexOf("Ready preview"));
  expect(stderr).toContain("Finished");
  stderr = "";
  const json = await runApp(app, ["ready", "photo.png", "--json"], { ...options, stderr: tty });
  expect(JSON.parse(json.stdout).status).toBe("planned");
  expect(stderr).not.toContain("\x1b");
  expect(stderr).not.toContain("\r");
  const redirected = await runApp(app, ["ready", "photo.png"], options);
  expect(redirected.stdout + redirected.stderr).not.toContain("\x1b");
  expect(await readdir(options.cwd)).toEqual(["photo.png"]);
});

test("ready --open is explicit, preview-safe and opens one created or reused report using a fake launcher", async () => {
  const options = await fixture();
  const launcher = join(options.cwd, "xdg-open"),
    log = join(options.cwd, "open-log");
  await writeFile(launcher, '#!/bin/sh\nprintf "%s" "$1" > "$SV_OPEN_LOG"\n');
  await chmod(launcher, 0o755);
  const env = { ...options.env, PATH: options.cwd, SV_OPEN_LOG: log };
  const args = ["ready", "photo.png", "--open", "--json"];
  const preview = await runApp(app, args, { ...options, env });
  expect(preview.code).toBe(0);
  expect(JSON.parse(preview.stdout).actions).toHaveLength(2);
  expect(await Bun.file(log).exists()).toBe(false);
  expect(await Bun.file(join(options.cwd, ".sv-ready")).exists()).toBe(false);
  const first = await runApp(app, [...args, "--yes"], { ...options, env });
  expect(first.code).toBe(0);
  const result = JSON.parse(first.stdout);
  expect(result.opened.success).toBe(true);
  expect(await readFile(log, "utf8")).toBe(pathToFileURL(result.opened.path).href);
  const repeated = await runApp(app, [...args, "--yes"], { ...options, env });
  expect(JSON.parse(repeated.stdout)).toMatchObject({ status: "reused", opened: { success: true } });
  expect(await readHistory({ ...options, env })).toHaveLength(1);
});

test("an all-reused apply revalidates without prompting or creating history", async () => {
  const options = await fixture();
  expect((await runApp(app, ["ready", "photo.png", "--yes"], options)).code).toBe(0);
  const noPrompt = createApp(sv, {
    context(base, intent) {
      return {
        ...createContext(base, intent),
        async confirm() {
          throw new Error("Nothing new should require approval");
        },
      };
    },
  });
  const result = await runApp(noPrompt, ["ready", "photo.png", "--apply", "--json"], options);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).status).toBe("reused");
  expect(await readHistory(options)).toHaveLength(1);
});

test("interactive progress reports failure when application returns a partial receipt", async () => {
  const options = await fixture();
  let stderr = "",
    raced = false;
  const result = await runApp(app, ["ready", "photo.png", "--yes"], {
    ...options,
    stderr: {
      isTTY: true,
      write(chunk: string) {
        stderr += chunk;
        if (!raced && chunk.includes("Writing")) {
          raced = true;
          mkdirSync(join(options.cwd, ".sv-ready"), { recursive: true });
          writeFileSync(join(options.cwd, ".sv-ready", "photo.webp"), "unrelated racing output");
        }
      },
    },
  });
  expect(result.code).toBe(1);
  expect(result.stdout).toContain("partial:");
  expect(stderr.slice(stderr.indexOf("Writing"))).toContain("Failed");
  expect(stderr.slice(stderr.indexOf("Writing"))).not.toContain("Finished");
  expect(await readFile(join(options.cwd, ".sv-ready", "photo.webp"), "utf8")).toBe(
    "unrelated racing output",
  );
});
