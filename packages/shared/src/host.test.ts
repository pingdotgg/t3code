import { describe, expect, it } from "vitest";

import {
  formatHostForUrl,
  isIpAddressHost,
  isLoopbackHost,
  isWildcardHost,
  normalizeHost,
} from "./host";

describe("host helpers", () => {
  it("normalizes bracketed IPv6 host strings", () => {
    expect(normalizeHost("[fd7a:115c:a1e0::1]")).toBe("fd7a:115c:a1e0::1");
  });

  it("formats IPv6 hosts for URLs", () => {
    expect(formatHostForUrl("fd7a:115c:a1e0::1")).toBe("[fd7a:115c:a1e0::1]");
    expect(formatHostForUrl("100.88.10.4")).toBe("100.88.10.4");
  });

  it("detects wildcard hosts", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("[::]")).toBe(true);
    expect(isWildcardHost("localhost")).toBe(false);
  });

  it("detects loopback hosts", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("100.88.10.4")).toBe(false);
  });

  it("detects IP address hosts", () => {
    expect(isIpAddressHost("100.88.10.4")).toBe(true);
    expect(isIpAddressHost("[fd7a:115c:a1e0::1]")).toBe(true);
    expect(isIpAddressHost("monitoring.tailnet.ts.net")).toBe(false);
  });
});
