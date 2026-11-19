/**
 * End-to-end: spawn the real `sv` entry point as a separate process.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pkg from "../package.json" with { type: "json" };

const main = join(import.meta.dir, "..", "src", "main.ts");

async function sv(args: readonly string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const child = Bun.spawn([process.execPath, main, ...args], {
    cwd: options.cwd ?? join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", ...options.env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

// A signature is irrelevant for `decode`; it only needs three valid segments.
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbGkifQ.97Hz4R7uksaLZcEeFO3Z9yvlKKYv9aPp-oXW98ZCe_g";

describe("sv", () => {
  test("bare sv prints an overview", async () => {
    const result = await sv([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`sv ${pkg.version}`);
    for (const group of ["img", "blog", "video", "gremlins", "tunnel", "port-forward", "jwt", "dev"]) {
      expect(result.stdout).toContain(group);
    }
  });

  test("--version", async () => {
    expect(await sv(["--version"])).toEqual({ code: 0, stdout: `sv ${pkg.version}\n`, stderr: "" });
  });

  test("groups list their commands", async () => {
    const img = await sv(["img", "--help"]);
    expect(img.code).toBe(0);
    for (const name of ["web", "og", "resize", "compare", "info"]) expect(img.stdout).toContain(name);

    const blog = await sv(["blog", "check", "--help"]);
    expect(blog.code).toBe(0);
    expect(blog.stdout).toContain("--config");
    expect(blog.stdout).toContain("--strict");

    const jwt = await sv(["jwt", "verify", "--help"]);
    expect(jwt.code).toBe(0);
    expect(jwt.stdout).toContain("--alg");
  });

  test("jwt decode never verifies and reports claims", async () => {
    const result = await sv(["jwt", "decode", TOKEN, "--json"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const decoded = JSON.parse(result.stdout) as {
      verified: boolean;
      payload: { sub: string };
      header: { alg: string };
    };
    expect(decoded.verified).toBe(false);
    expect(decoded.header.alg).toBe("HS256");
    expect(decoded.payload.sub).toBe("cli");
  });

  test("jwt verify requires an explicit algorithm", async () => {
    const result = await sv(["jwt", "verify", TOKEN, "--secret-env", "JWT_SECRET"], {
      env: { JWT_SECRET: "this-is-a-test-secret-value" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Provide --alg explicitly");
  });

  test("jwt sign and verify round-trip", async () => {
    const secret = "this-is-a-test-secret-value";
    const signed = await sv(
      ["jwt", "sign", "--payload", '{"sub":"roundtrip"}', "--secret-env", "JWT_SECRET", "--json"],
      { env: { JWT_SECRET: secret } },
    );
    expect(signed.code).toBe(0);
    const token = (JSON.parse(signed.stdout) as { token: string }).token;

    const verified = await sv(
      ["jwt", "verify", token, "--alg", "HS256", "--secret-env", "JWT_SECRET", "--json"],
      { env: { JWT_SECRET: secret } },
    );
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ valid: true, payload: { sub: "roundtrip" } });
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

  test("SSH forwarding picks a free port and honors an explicit local port", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sv-ssh-"));
    const fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("fixture"),
    });
    const target = fixture.port!;
    try {
      await writeFile(join(directory, "ssh"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const env = { PATH: directory };
      const automatic = await sv(["port-forward", "jab-carbon", String(target)], { env });
      expect(automatic.code).toBe(0);
      const selected = Number(/Opening SSH forward on 127\.0\.0\.1:(\d+)/.exec(automatic.stdout)?.[1]);
      expect(selected).toBeGreaterThan(target);
      expect(automatic.stdout).toContain(`-L\n127.0.0.1:${selected}:localhost:${target}\n--\njab-carbon\n`);
      expect(automatic.stdout).toContain("ExitOnForwardFailure=yes");

      const occupied = await sv(["pf", "dev@example.com", "3000", String(target)], { env });
      expect(occupied.code).toBe(1);
      expect(occupied.stderr).toContain(`Local port ${target} is already in use`);
      expect(occupied.stdout).toBe("");

      const explicit = await sv(["pf", "dev@example.com", "3000", String(selected)], { env });
      expect(explicit.code).toBe(0);
      expect(explicit.stdout).toContain(`-L\n127.0.0.1:${selected}:localhost:3000\n--\ndev@example.com\n`);
    } finally {
      await fixture.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("SSH forwarding rejects invalid ports before starting SSH", async () => {
    for (const args of [
      ["jab-carbon", "0"],
      ["jab-carbon", "3000", "65536"],
    ]) {
      expect((await sv(["pf", ...args], { env: { PATH: "/nonexistent" } })).code).toBe(2);
    }
  });

  test("usage errors exit with 2 and explain themselves", async () => {
    const misplaced = await sv(["img", "web", "--verbose"]);
    expect(misplaced.code).toBe(2);
    expect(misplaced.stderr).toContain("unexpected: `--verbose`");
    expect(misplaced.stderr).toContain("hint: --verbose is an option of `sv`; put it before `img`");
    expect(misplaced.stderr).toContain("Run `sv img web --help` for usage.");

    const group = await sv(["img"]);
    expect(group.code).toBe(2);
    expect(group.stderr).toContain("Commands:\n  web");
  });

  test("completion protocol", async () => {
    expect((await sv(["complete", "--", "img", ""])).stdout).toContain(
      "web\tConvert images to WebP for the web, resizing to a maximum width",
    );
    expect((await sv(["complete", "--", "img", ""])).stdout).toEndWith(":4\n");
    expect((await sv(["complete", "--", "img", "web", "--format", ""])).stdout).toBe(
      "webp\tBroad browser support\navif\tSmaller, slower to encode\n:4\n",
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
