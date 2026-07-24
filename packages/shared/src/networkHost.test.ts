import { describe, expect, it } from "vite-plus/test";

import { isLoopbackAddress, isLoopbackHost } from "./networkHost.ts";

describe("isLoopbackAddress", () => {
  it.each(["127.0.0.1", "127.0.0.2", "::1", "[::1]"])(
    "accepts the loopback address literal %s",
    (host) => {
      expect(isLoopbackAddress(host)).toBe(true);
    },
  );

  it.each([
    undefined,
    "",
    "localhost",
    "127.attacker.example",
    "127.0.0.256",
    "127.00.0.1",
    "0.0.0.0",
  ])("rejects the unsafe or non-literal host %s", (host) => {
    expect(isLoopbackAddress(host)).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("retains localhost for callers that model effective server binds", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost(undefined)).toBe(false);
  });
});
