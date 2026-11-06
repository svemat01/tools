import { expect, test } from "bun:test";

import { sv } from "../src/app.ts";
import { createContext } from "../src/context.ts";
import { createApp } from "../src/kit/index.ts";
import { runApp } from "./support/io.ts";

const secret = "a-long-test-secret-for-jwt-input";
const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjbGkifQ.97Hz4R7uksaLZcEeFO3Z9yvlKKYv9aPp-oXW98ZCe_g";
function withStdin(text: string) {
  let reads = 0;
  const app = createApp(sv, {
    context(base, intent) {
      return {
        ...createContext(base, intent),
        async readStdin() {
          reads++;
          return text;
        },
      };
    },
  });
  return { app, reads: () => reads };
}

test("JWT token stdin uses the application input service", async () => {
  const input = withStdin(`  ${token}\n`);
  const result = await runApp(input.app, ["jwt", "decode", "--stdin", "--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).payload.sub).toBe("cli");
  expect(input.reads()).toBe(1);
});

test("JWT payload and secret stdin can each be supplied without global stdin", async () => {
  const payload = withStdin('{"sub":"from-stdin"}');
  const result = await runApp(
    payload.app,
    ["jwt", "sign", "--payload-stdin", "--secret-env", "JWT_SECRET", "--json"],
    { env: { JWT_SECRET: secret } },
  );
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).payload.sub).toBe("from-stdin");
  expect(payload.reads()).toBe(1);
  const key = withStdin(`${secret}\n`);
  const signed = await runApp(key.app, ["jwt", "sign", "--secret-stdin", "--json"]);
  expect(signed.code).toBe(0);
  expect(JSON.parse(signed.stdout).token).toBeString();
  expect(key.reads()).toBe(1);
});

test("JWT conflicting stdin sources fail before consuming input", async () => {
  const input = withStdin(secret);
  const result = await runApp(input.app, ["jwt", "sign", "--secret-stdin", "--payload-stdin"]);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Only one value can be read from stdin");
  expect(input.reads()).toBe(0);
});
