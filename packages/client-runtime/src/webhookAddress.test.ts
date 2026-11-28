import { describe, expect, it } from "vite-plus/test";

import { webhookAddress } from "./webhookAddress.ts";

const endpoint = {
  path: "/hooks/abc",
  url: null,
  hasSecret: true,
};

describe("webhookAddress", () => {
  it("returns the public endpoint URL copyable with no note", () => {
    const result = webhookAddress(
      { ...endpoint, url: "https://connect.example.com/hooks/abc" },
      null,
    );
    expect(result.address).toBe("https://connect.example.com/hooks/abc");
    expect(result.copyable).toBe(true);
    expect(result.note).toBeNull();
  });

  it("is not copyable and points at T3 Connect when no base URL exists", () => {
    const result = webhookAddress(endpoint, null);
    expect(result.address).toBe("/hooks/abc");
    expect(result.copyable).toBe(false);
    expect(result.note).toContain("T3 Connect");
  });

  it("warns that loopback addresses only work on this computer", () => {
    const result = webhookAddress(endpoint, "http://127.0.0.1:8787");
    expect(result.address).toBe("http://127.0.0.1:8787/hooks/abc");
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Only this computer");
  });

  it("explains reachability for non-loopback hosts", () => {
    const result = webhookAddress(endpoint, "https://home.example.net");
    expect(result.address).toBe("https://home.example.net/hooks/abc");
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Tailscale");
  });
});
