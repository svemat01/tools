import { describe, expect, test } from "bun:test";

import { cloudflaredArgs, findTunnelUrl, TUNNEL_URL_PATTERN } from "../../src/lib/tunnel.ts";

describe("findTunnelUrl", () => {
  test("finds a Quick Tunnel URL in cloudflared output", () => {
    const line = "2026-01-01T00:00:00Z INF |  https://quiet-river-1234.trycloudflare.com  |";
    expect(findTunnelUrl(line)).toBe("https://quiet-river-1234.trycloudflare.com");
  });

  test("returns undefined when there is no URL", () => {
    expect(findTunnelUrl("starting tunnel")).toBeUndefined();
  });

  test("the pattern is not stateful across calls", () => {
    const text = "https://one.trycloudflare.com https://two.trycloudflare.com";
    expect(findTunnelUrl(text)).toBe("https://one.trycloudflare.com");
    expect(findTunnelUrl(text)).toBe("https://one.trycloudflare.com");
    expect(TUNNEL_URL_PATTERN.global).toBe(false);
  });
});

describe("cloudflaredArgs", () => {
  test("builds a Quick Tunnel command for the local port", () => {
    expect(cloudflaredArgs(3000)).toEqual(["tunnel", "--no-autoupdate", "--url", "http://localhost:3000"]);
  });

  test("supports a custom local host", () => {
    expect(cloudflaredArgs(8080, "127.0.0.1")).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--url",
      "http://127.0.0.1:8080",
    ]);
  });
});
