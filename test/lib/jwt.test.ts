import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimState,
  decodeToken,
  isJwtAlgorithm,
  isSymmetricAlgorithm,
  parseDuration,
  readSecret,
  signJwt,
  verifyJwt,
} from "../../src/lib/jwt.ts";

const SECRET = "this-is-a-test-secret-value";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbGkifQ.97Hz4R7uksaLZcEeFO3Z9yvlKKYv9aPp-oXW98ZCe_g";
const directories: string[] = [];

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sv-jwt-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("decodeToken", () => {
  test("reads the header, payload and signature without a secret", () => {
    const decoded = decodeToken(TOKEN);
    expect(decoded.header).toEqual({ alg: "HS256" });
    expect(decoded.payload).toEqual({ sub: "cli" });
    expect(decoded.signature).toBe("97Hz4R7uksaLZcEeFO3Z9yvlKKYv9aPp-oXW98ZCe_g");
    expect(decoded.segments).toBe(3);
  });

  test("rejects a token without three segments", () => {
    expect(() => decodeToken("not.a.token.with.too.many")).toThrow("three dot-separated segments");
  });
});

describe("signJwt and verifyJwt", () => {
  test("round-trips HS256 claims", async () => {
    const token = await signJwt({
      algorithm: "HS256",
      secret: SECRET,
      payload: { role: "admin" },
      expiresIn: "1h",
      issuer: "sv",
      audience: "tests",
      subject: "user-1",
      jwtId: "id-1",
      issuedAt: true,
    });
    const result = await verifyJwt(token, {
      algorithm: "HS256",
      secret: SECRET,
      issuer: "sv",
      audience: "tests",
    });
    expect(result.payload).toMatchObject({
      role: "admin",
      iss: "sv",
      aud: "tests",
      sub: "user-1",
      jti: "id-1",
    });
    expect(typeof result.payload.exp).toBe("number");
    expect(typeof result.payload.iat).toBe("number");
  });

  test("does not trust the token header to choose the algorithm", async () => {
    const token = await signJwt({ algorithm: "HS256", secret: SECRET, payload: {} });
    await expect(verifyJwt(token, { algorithm: "HS512", secret: SECRET })).rejects.toThrow();
  });

  test("rejects an expired token", async () => {
    const token = await signJwt({
      algorithm: "HS256",
      secret: SECRET,
      payload: { exp: Math.floor(Date.now() / 1000) - 60 },
      issuedAt: false,
    });
    await expect(verifyJwt(token, { algorithm: "HS256", secret: SECRET })).rejects.toThrow();
  });

  test("requires a reasonably sized HMAC secret", async () => {
    await expect(signJwt({ algorithm: "HS256", secret: "short", payload: {} })).rejects.toThrow(
      "at least 16 characters",
    );
  });

  test("adds extra headers such as kid", async () => {
    const token = await signJwt({
      algorithm: "HS256",
      secret: SECRET,
      payload: {},
      extraHeaders: { kid: "key-1" },
    });
    expect(decodeToken(token).header).toMatchObject({ alg: "HS256", kid: "key-1" });
  });
});

describe("claimState", () => {
  test("reports expiry and remaining time", () => {
    const state = claimState({ exp: 1000, iat: 500, nbf: 600 }, 900);
    expect(state).toMatchObject({
      expiresAt: 1000,
      issuedAt: 500,
      notBefore: 600,
      expired: false,
      notYetValid: false,
      secondsRemaining: 100,
    });
  });

  test("detects expired and not-yet-valid tokens", () => {
    expect(claimState({ exp: 10 }, 20).expired).toBe(true);
    expect(claimState({ nbf: 20 }, 10).notYetValid).toBe(true);
  });
});

describe("parseDuration", () => {
  test("parses common units", () => {
    expect(parseDuration("30s")).toBe(30);
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("7d")).toBe(604800);
    expect(parseDuration("1w")).toBe(604800);
    expect(parseDuration("1.5h")).toBe(5400);
  });

  test("rejects invalid input", () => {
    expect(() => parseDuration("soon")).toThrow("Invalid duration");
  });
});

describe("readSecret", () => {
  test("reads an environment variable", async () => {
    await expect(
      readSecret({ kind: "env", name: "JWT_SECRET" }, { env: { JWT_SECRET: SECRET }, cwd: "/" }),
    ).resolves.toBe(SECRET);
  });

  test("reports a missing environment variable", async () => {
    await expect(readSecret({ kind: "env", name: "JWT_SECRET" }, { env: {}, cwd: "/" })).rejects.toThrow(
      "not set or is empty",
    );
  });

  test("reads a file relative to cwd and trims one trailing newline", async () => {
    const directory = await temporary();
    await writeFile(join(directory, "secret.txt"), `${SECRET}\n`);
    await expect(readSecret({ kind: "file", path: "secret.txt" }, { env: {}, cwd: directory })).resolves.toBe(
      SECRET,
    );
  });
});

describe("algorithm helpers", () => {
  test("recognizes supported algorithms", () => {
    expect(isJwtAlgorithm("HS256")).toBe(true);
    expect(isJwtAlgorithm("none")).toBe(false);
    expect(isSymmetricAlgorithm("HS512")).toBe(true);
    expect(isSymmetricAlgorithm("RS256")).toBe(false);
  });
});
