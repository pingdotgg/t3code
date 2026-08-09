import { describe, expect, it } from "vite-plus/test";

import { isPrivateLinkHost } from "./privateLinkHost";

describe("isPrivateLinkHost", () => {
  it("treats public hosts as public", () => {
    for (const host of [
      "github.com",
      "www.google.com",
      "t3.chat",
      "sub.domain.example.co.uk",
      "8.8.8.8",
      "1.1.1.1",
      "100.200.1.1",
      "172.32.0.1",
      "192.167.1.1",
      "11.0.0.1",
    ]) {
      expect(isPrivateLinkHost(host), host).toBe(false);
    }
  });

  it("detects private IPv4 ranges", () => {
    for (const host of [
      "10.0.0.1",
      "10.255.255.255",
      "127.0.0.1",
      "192.168.1.10",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.1.1",
    ]) {
      expect(isPrivateLinkHost(host), host).toBe(true);
    }
  });

  it("detects the Tailscale 100.64.0.0/10 range", () => {
    for (const host of ["100.64.0.1", "100.100.100.100", "100.126.17.15", "100.127.255.255"]) {
      expect(isPrivateLinkHost(host), host).toBe(true);
    }
    expect(isPrivateLinkHost("100.63.255.255")).toBe(false);
    expect(isPrivateLinkHost("100.128.0.1")).toBe(false);
  });

  it("detects private host names and suffixes", () => {
    for (const host of [
      "localhost",
      "air",
      "printer.local",
      "api.internal",
      "router.home.arpa",
      "box.tailnet.ts.net",
      "AIR.TAILE8BEA7.TS.NET",
    ]) {
      expect(isPrivateLinkHost(host), host).toBe(true);
    }
  });

  it("detects private IPv6 addresses", () => {
    for (const host of ["::1", "[::1]", "fd00::1", "fc00::1", "fe80::1", "FD12:3456::1"]) {
      expect(isPrivateLinkHost(host), host).toBe(true);
    }
    expect(isPrivateLinkHost("2606:4700:4700::1111")).toBe(false);
  });

  it("treats an empty host as private", () => {
    expect(isPrivateLinkHost("")).toBe(true);
    expect(isPrivateLinkHost("   ")).toBe(true);
  });

  it("rejects malformed IPv4 text as a public host", () => {
    expect(isPrivateLinkHost("10.0.0.999")).toBe(false);
    expect(isPrivateLinkHost("10.0.0")).toBe(false);
  });
});
