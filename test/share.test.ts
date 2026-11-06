import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { app } from "../src/app.ts";
import {
  inspectShareDirectory,
  parseShareService,
  SHARE_LIMITS,
  shareDuration,
  shareHandler,
} from "../src/lib/share.ts";
import { capture, runApp } from "./support/io.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp("/tmp/sv-share-");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const put = (path: string, text = "hello") => writeFile(join(root, path), text);
const request = (path: string, method = "GET") => new Request(`http://127.0.0.1${path}`, { method });
const run = (args: string[]) => runApp(app, args, { cwd: root, env: { PATH: "/nonexistent" } });

test("strict loopback parsing does no network IO", () => {
  for (const value of ["3000", "http://127.2.3.4:80/a?q=1", "https://localhost/", "http://[::1]:8080/"])
    expect(parseShareService(value)).toBeString();
  expect(parseShareService("./site")).toBeUndefined();
  for (const value of [
    "0",
    "65536",
    "http://evil.test",
    "http://localhost.evil.test",
    "http://127.1",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://[::ffff:127.0.0.1]",
    "http://user@localhost",
    "http://localhost:0",
    "ftp://localhost",
    "http://localhost/#x",
    "http://localhost:99999",
    "http://localhost\\@evil.test",
  ])
    expect(() => parseShareService(value)).toThrow();
  expect(shareDuration("1.5m")).toBe(90000);
  for (const value of ["0s", "1d", "Infinitys", "999999h"]) expect(() => shareDuration(value)).toThrow();
});

test("manifest excludes hidden, generated, symlinks and bounds traversal/files/bytes/depth", async () => {
  await put("ok.txt");
  await put(".env", "secret");
  for (const name of [".git", "vendor", "node_modules", "dist"]) {
    await mkdir(join(root, name));
    await put(`${name}/secret`);
  }
  await symlink(join(root, "ok.txt"), join(root, "link"));
  expect([...(await inspectShareDirectory(root)).files.keys()]).toEqual(["ok.txt"]);
  for (const limits of [{ entries: 1 }, { files: 0 }, { bytes: 1 }])
    await expect(inspectShareDirectory(root, undefined, { ...SHARE_LIMITS, ...limits })).rejects.toThrow(
      "limit",
    );
  await mkdir(join(root, "nested"));
  await expect(inspectShareDirectory(root, undefined, { ...SHARE_LIMITS, depth: 0 })).rejects.toThrow(
    "depth",
  );
  await expect(inspectShareDirectory(join(root, "link"))).rejects.toThrow();
});

test("handler serves only inspected files; HEAD, MIME, errors and escaped index", async () => {
  await put("a & <b> 'x'.txt");
  await put(".env", "secret");
  const handler = shareHandler(await inspectShareDirectory(root));
  const index = await (await handler(request("/"))).text();
  expect(index).toContain("a &amp; &lt;b&gt; &#39;x&#39;.txt");
  expect(index).toContain("a%20%26%20%3Cb%3E%20&#39;x&#39;.txt");
  expect(index).not.toContain(".env");
  const url = "/" + encodeURIComponent("a & <b> 'x'.txt");
  expect(await (await handler(request(url))).text()).toBe("hello");
  const head = await handler(request(url, "HEAD"));
  expect(head.status).toBe(200);
  expect(head.headers.get("content-type")).toContain("text/plain");
  expect(await head.text()).toBe("");
  expect((await handler(request(url, "POST"))).status).toBe(405);
  await put("new.txt", "new secret");
  for (const path of [
    "/.env",
    "/%2eenv",
    "/%252eenv",
    "/../secret",
    "/%2e%2e/secret",
    "/..%2fsecret",
    "/%5c..%5csecret",
    "/%00",
    "/%zz",
    "/new.txt",
  ]) {
    const response = await handler(request(path));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  }
});

test("replacements, edited files, symlink and ancestor swap cannot expose new bytes", async () => {
  await mkdir(join(root, "dir"));
  await put("dir/a.txt");
  await put("secret", "private");
  const handler = shareHandler(await inspectShareDirectory(root));
  await rename(join(root, "dir/a.txt"), join(root, "old"));
  await put("dir/a.txt", "private");
  expect((await handler(request("/dir/a.txt"))).status).toBe(409);
  await rm(join(root, "dir/a.txt"));
  await symlink(join(root, "secret"), join(root, "dir/a.txt"));
  expect((await handler(request("/dir/a.txt"))).status).toBe(404);
  await rm(join(root, "dir"), { recursive: true });
  await symlink(root, join(root, "dir"));
  expect((await handler(request("/dir/a.txt"))).status).toBe(404);
  await put("secret", "changed");
  expect((await handler(request("/secret"))).status).toBe(409);
});

test("dry run/preview and --cwd inspect only, public missing optional binary; approval required", async () => {
  await put("index.html", "fixture");
  const dry = await runApp(app, ["--cwd", root, "share", ".", "--public", "--dry-run", "--json"], {
    env: { PATH: "/nonexistent" },
  });
  expect(dry.code).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({
    event: "planned",
    mode: "public",
    target: root,
    files: ["index.html"],
  });
  expect((await run(["share", "http://127.0.0.1:65534", "--preview", "--json"])).code).toBe(0);
  expect((await run(["share", ".", "--json"])).code).toBe(1);
  const missing = await run(["share", ".", "--public", "--yes", "--json"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("cloudflared");
  expect(missing.stderr).toContain("Install");
  expect(missing.stdout).toBe("");
});

async function session(
  args: string[],
  check: (url: string) => Promise<void>,
  env = { PATH: "/nonexistent" },
) {
  const controller = new AbortController();
  const stderr = capture();
  let finished = false;
  let resolveReady!: (url: string) => void;
  const ready = new Promise<string>((done) => {
    resolveReady = done;
  });
  const stdout = {
    write(text: string) {
      const event = JSON.parse(text);
      expect(event.event).toBe("ready");
      resolveReady(event.url);
    },
  };
  const running = app
    .run(["share", ...args, "--yes", "--json"], { cwd: root, env, signal: controller.signal, stdout, stderr })
    .then((code) => {
      finished = true;
      return code;
    });
  try {
    const url = await Promise.race([
      ready,
      running.then(() => {
        throw new Error(stderr.text);
      }),
    ]);
    expect(finished).toBe(false);
    await check(url);
  } finally {
    controller.abort();
    await running;
  }
  expect(await running).toBe(0);
}

test("JSON ready precedes stop, static fixture reachable then server closes on cancellation", async () => {
  await put("index.html", "fixture");
  let url = "";
  await session(["."], async (ready) => {
    url = ready;
    expect(await (await fetch(url)).text()).toBe("fixture");
  });
  await expect(fetch(url)).rejects.toThrow();
});

test("timeout ends local session and closes listener", async () => {
  await put("a");
  const stdout = capture();
  expect(
    await app.run(["share", ".", "--yes", "--json", "--timeout", "50ms"], {
      cwd: root,
      env: { PATH: "/nonexistent" },
      stdout,
      stderr: capture(),
    }),
  ).toBe(0);
  await expect(fetch(JSON.parse(stdout.text).url)).rejects.toThrow();
});

async function fakeTunnel(ready = true) {
  await put(
    "cloudflared",
    `#!/bin/sh\nprintf '%s' "$*" > '${root}/args'\nprintf '%s' "$$" > '${root}/pid'\n${ready ? "echo https://fixture.trycloudflare.com >&2" : ""}\nwhile :; do :; done\n`,
  );
  await chmod(join(root, "cloudflared"), 0o755);
}

test("public uses existing lifecycle, readiness/cancellation, exact HTTPS IPv6 service target", async () => {
  await fakeTunnel();
  await session(
    ["https://[::1]:8443/", "--public"],
    async (url) => {
      expect(url).toBe("https://fixture.trycloudflare.com");
    },
    { PATH: root },
  );
  expect(await readFile(join(root, "args"), "utf8")).toContain("--url https://[::1]:8443/");
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("public timeout before readiness cleans tunnel and static server", async () => {
  await fakeTunnel(false);
  const result = await runApp(app, ["share", ".", "--public", "--yes", "--json", "--timeout", "100ms"], {
    cwd: root,
    env: { PATH: root },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toBe("");
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

test("file/symlink swaps racing requests never return outside content", async () => {
  await put("safe.txt", "public");
  const handler = shareHandler(await inspectShareDirectory(root));
  const outside = await mkdtemp("/tmp/sv-share-outside-");
  try {
    await writeFile(join(outside, "secret.txt"), "PRIVATE OUTSIDE");
    for (let i = 0; i < 20; i++) {
      const response = handler(request("/safe.txt"));
      await rm(join(root, "safe.txt"));
      await symlink(join(outside, "secret.txt"), join(root, "safe.txt"));
      expect(await (await response).text()).not.toContain("PRIVATE OUTSIDE");
      await rm(join(root, "safe.txt"));
      await put("safe.txt", "public");
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("dry-run does not bind even when selected port is already occupied", async () => {
  await put("index.html", "fixture");
  const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("fixture") });
  try {
    expect(
      (await run(["share", ".", "--public", "--port", String(fixture.port), "--dry-run", "--yes"])).code,
    ).toBe(0);
  } finally {
    await fixture.stop(true);
  }
});

test("optional copy uses only a fake clipboard binary and the ready URL", async () => {
  await put("pbcopy", `#!/bin/sh\n/bin/cat > '${root}/copied'\n`);
  await chmod(join(root, "pbcopy"), 0o755);
  await put("index.html", "fixture");
  const result = await runApp(app, ["share", ".", "--yes", "--json", "--copy", "--timeout", "100ms"], {
    cwd: root,
    env: { PATH: root },
  });
  expect(result.code).toBe(0);
  expect(await readFile(join(root, "copied"), "utf8")).toBe(JSON.parse(result.stdout).url);
});

test("uncooperative fake tunnel receives forced stop after timeout", async () => {
  await put(
    "cloudflared",
    `#!/bin/sh\ntrap '' TERM\nprintf '%s' "$$" > '${root}/pid'\necho https://fixture.trycloudflare.com >&2\nwhile :; do :; done\n`,
  );
  await chmod(join(root, "cloudflared"), 0o755);
  const result = await runApp(app, ["share", "3000", "--public", "--yes", "--json", "--timeout", "100ms"], {
    cwd: root,
    env: { PATH: root },
  });
  expect(result.code).toBe(0);
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});
