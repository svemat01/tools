import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { app, sv } from "../src/app.ts";
import { createContext } from "../src/context.ts";
import { createApp } from "../src/kit/index.ts";
import { type ClipboardReadOptions, readClipboard } from "../src/lib/clipboard.ts";
import { summarizeClipboard } from "../src/lib/paste.ts";
import { runApp } from "./support/io.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "sv-paste-"));
  dirs.push(dir);
  return dir;
}
const fake: ClipboardReadOptions = {
  platform: "linux",
  env: { WAYLAND_DISPLAY: "fake" },
  find: (name) => (name === "wl-paste" ? "/fake/wl-paste" : undefined),
};
function reader(text: string, types = "text/plain") {
  return {
    ...fake,
    run: async (_cmd: string, args: readonly string[]) =>
      Buffer.from(args.includes("--list-types") ? types : text),
  };
}
async function fixture(text: Uint8Array | string, types = "text/plain", script?: string) {
  const dir = await directory();
  await writeFile(join(dir, "payload"), text);
  await writeFile(
    join(dir, "wl-paste"),
    script ??
      '#!/bin/sh\nif [ "$1" = "--list-types" ]; then printf "%s\\n" "$FAKE_TYPES"; else /bin/cat "$FAKE_PAYLOAD"; fi\n',
  );
  await chmod(join(dir, "wl-paste"), 0o755);
  return {
    dir,
    env: {
      PATH: dir,
      WAYLAND_DISPLAY: "fake",
      FAKE_TYPES: types,
      FAKE_PAYLOAD: join(dir, "payload"),
      XDG_STATE_HOME: join(dir, "state"),
    },
  };
}

test("missing readers and desktop failures are actionable and never echo diagnostics", async () => {
  await expect(readClipboard({ ...fake, find: () => undefined })).rejects.toMatchObject({
    code: "unavailable",
  });
  const f = await fixture("", "text/plain", '#!/bin/sh\nprintf "private-token" >&2\nexit 1\n');
  await expect(readClipboard({ env: f.env })).rejects.toMatchObject({ code: "access" });
  const result = await runApp(app, ["paste", "--json"], { env: f.env });
  expect(result.code).toBe(1);
  expect(result.stderr).not.toContain("private-token");
});

test("bounded reads, timeout and cancellation use fake processes", async () => {
  const f = await fixture("x".repeat(2048));
  await expect(readClipboard({ env: f.env, maxBytes: 32 })).rejects.toMatchObject({ code: "too-large" });
  const slow = await fixture("", "text/plain", "#!/bin/sh\nexec /bin/sleep 10\n");
  await expect(readClipboard({ env: slow.env, timeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
  const controller = new AbortController();
  const pending = readClipboard({ env: slow.env, signal: controller.signal });
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  await expect(readClipboard({ ...reader("oversized"), maxBytes: 2 })).rejects.toMatchObject({
    code: "too-large",
  });
});

test("format negotiation validates PNG bytes and dimensions, rejecting unsupported images", async () => {
  const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const f = await fixture(png, "text/plain\nimage/png");
  const result = await readClipboard({ env: f.env });
  expect(result).toMatchObject({ kind: "image", mime: "image/png", width: 3, height: 2 });
  expect(Buffer.from(result.bytes)).toEqual(png);
  await expect(readClipboard(reader("secret", "image/png"))).rejects.toMatchObject({ code: "invalid" });
  await expect(readClipboard(reader("secret", "image/jpeg"))).rejects.toMatchObject({ code: "unsupported" });
  await expect(
    readClipboard({
      ...fake,
      run: async (_cmd, args) =>
        args.includes("--list-types") ? Buffer.from("image/png") : png.subarray(0, 40),
    }),
  ).rejects.toMatchObject({ code: "invalid" });
});

test("text-only backends and xclip use fixed argv, never pasted data", async () => {
  for (const backend of ["pbpaste", "xsel", "powershell.exe", "xclip"]) {
    const calls: string[][] = [];
    const result = await readClipboard({
      platform: backend === "pbpaste" ? "darwin" : backend === "powershell.exe" ? "win32" : "linux",
      find: (name) => (name === backend ? backend : undefined),
      run: async (_cmd, args) => {
        calls.push([...args]);
        return Buffer.from(args.includes("TARGETS") ? "UTF8_STRING" : "$(never-execute); token");
      },
    });
    expect(result.kind).toBe("text");
    expect(JSON.stringify(calls)).not.toContain("never-execute");
  }
});

test("classification is metadata only for JWTs, URLs, text, readable paths", async () => {
  const dir = await directory();
  await writeFile(join(dir, "file with spaces"), "content");
  for (const [text, kind] of [
    ["eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZWNyZXQifQ.signature", "jwt"],
    ["https://user:secret@example.com/?token=secret", "url"],
    ["unknown private secret", "text"],
    ["file with spaces", "paths"],
    ["file with spaces\nmissing", "text"],
  ] as const) {
    const payload = await readClipboard(reader(text));
    const summary = await summarizeClipboard(payload, dir);
    expect(summary.kind).toBe(kind);
    expect(JSON.stringify(summary)).not.toContain(text);
  }
});

test("mounted command redacts stdout/stderr and saves exact private bytes under --cwd without history or clobber", async () => {
  const token = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZWNyZXQifQ.signature";
  const f = await fixture(token);
  const misleading = await runApp(app, ["paste", "--out", "secret.png", "--yes"], { env: f.env, cwd: f.dir });
  expect(misleading.code).toBe(1);
  expect(misleading.stderr).toContain("returned text");
  const summary = await runApp(app, ["paste", "--json"], { env: f.env });
  expect(summary.code).toBe(0);
  expect(JSON.parse(summary.stdout)).toMatchObject({ kind: "jwt", status: "summary" });
  expect(summary.stdout + summary.stderr).not.toContain(token);
  const declined = await runApp(app, ["paste", "--out", "secret.txt", "--json"], { env: f.env, cwd: f.dir });
  expect(declined.code).toBe(1);
  expect(await readdir(f.dir)).not.toContain("secret.txt");
  const args = ["--cwd", f.dir, "paste", "--out", "secret.txt", "--yes", "--json"];
  const saved = await runApp(app, args, { env: f.env });
  expect(saved.code).toBe(0);
  expect(JSON.parse(saved.stdout).status).toBe("saved");
  expect(saved.stdout + saved.stderr).not.toContain(token);
  expect(await readFile(join(f.dir, "secret.txt"), "utf8")).toBe(token);
  expect((await stat(join(f.dir, "secret.txt"))).mode & 0o777).toBe(0o600);
  await writeFile(join(f.dir, "payload"), "replacement");
  expect((await runApp(app, args, { env: f.env })).code).toBe(1);
  expect(await readFile(join(f.dir, "secret.txt"), "utf8")).toBe(token);
  expect(await readdir(f.dir)).not.toContain("state");
});

test("image save requires matching extension and JSON contains no image bytes", async () => {
  const png = await sharp({ create: { width: 2, height: 4, channels: 3, background: "blue" } })
    .png()
    .toBuffer();
  const f = await fixture(png, "image/png");
  const bad = await runApp(app, ["paste", "--out", "out.jpg", "--yes"], { env: f.env, cwd: f.dir });
  expect(bad.code).toBe(1);
  expect(bad.stderr).toContain(".png");
  const saved = await runApp(app, ["paste", "--out", "out.png", "--yes", "--json"], {
    env: f.env,
    cwd: f.dir,
  });
  expect(saved.code).toBe(0);
  expect(JSON.parse(saved.stdout)).toMatchObject({ kind: "image", width: 2, height: 4 });
  expect(saved.stdout).not.toContain(png.toString("base64"));
  expect(await readFile(join(f.dir, "out.png"))).toEqual(png);
});

test("confirmation sees destination preview before saving; JSON never prompts", async () => {
  const f = await fixture("secret text");
  let prompts = 0;
  const interactive = createApp(sv, {
    context(base, intent) {
      return {
        ...createContext(base, intent),
        confirm: async () => {
          prompts++;
          // The command has already emitted the preview; no output has been published yet.
          expect(await readdir(f.dir)).not.toContain("confirmed.txt");
          return true;
        },
      };
    },
  });
  const saved = await runApp(interactive, ["paste", "--out", "confirmed.txt"], { env: f.env, cwd: f.dir });
  expect(saved.code).toBe(0);
  expect(saved.stderr).toContain(join(f.dir, "confirmed.txt"));
  expect(prompts).toBe(1);
  const declined = await runApp(interactive, ["paste", "--out", "json.txt", "--json"], {
    env: f.env,
    cwd: f.dir,
  });
  expect(declined.code).toBe(1);
  expect(prompts).toBe(1);
});

test("empty and binary text representations are explicitly unsupported", async () => {
  await expect(readClipboard(reader(""))).rejects.toMatchObject({ code: "unsupported" });
  await expect(readClipboard(reader("text\0binary"))).rejects.toMatchObject({ code: "unsupported" });
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(readClipboard({ ...fake, signal: cancelled.signal })).rejects.toMatchObject({
    code: "cancelled",
  });
});

test("saved clipboard handoffs use exact shell-safe destinations and retain working directory", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const f = await fixture(png, "image/png");
  const name = "a 'quoted' $(still-data).png";
  const result = await runApp(app, ["--cwd", f.dir, "paste", "--out", name, "--yes", "--json"], {
    env: f.env,
  });
  expect(result.code).toBe(0);
  const saved = JSON.parse(result.stdout);
  expect(saved.suggestions).toHaveLength(2);
  expect(saved.suggestions.join("\n")).not.toContain("<saved-path>");
  expect(saved.suggestions[1]).toContain("--cwd");
  expect(saved.suggestions[1]).toContain("img tune");
  const log = join(f.dir, "handoff.log");
  const child = Bun.spawn(
    ["bash", "-c", 'sv() { printf "%s\\0" "$@" > "$SV_ARGV_LOG"; }; ' + saved.suggestions[1]],
    {
      env: { ...process.env, SV_ARGV_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await child.exited).toBe(0);
  expect((await readFile(log, "utf8")).split("\0").slice(0, -1)).toEqual([
    "--cwd",
    f.dir,
    "img",
    "tune",
    join(f.dir, name),
  ]);
});
