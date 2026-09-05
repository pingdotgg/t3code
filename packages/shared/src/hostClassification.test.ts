import { describe, expect, it } from "vite-plus/test";

import { isPublicFaviconHost } from "./hostClassification.ts";

describe("isPublicFaviconHost", () => {
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
      expect(isPublicFaviconHost(host), host).toBe(true);
    }
  });

  it("detects private IPv4 ranges", () => {
    for (const host of [
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "127.0.0.1",
      "192.168.1.10",
      "172.16.0.1",
      "172.31.255.255",
      "169.254.1.1",
    ]) {
      expect(isPublicFaviconHost(host), host).toBe(false);
    }
  });

  it("detects the Tailscale 100.64.0.0/10 range", () => {
    for (const host of ["100.64.0.1", "100.100.100.100", "100.126.17.15", "100.127.255.255"]) {
      expect(isPublicFaviconHost(host), host).toBe(false);
    }
    expect(isPublicFaviconHost("100.63.255.255")).toBe(true);
    expect(isPublicFaviconHost("100.128.0.1")).toBe(true);
  });

  it("detects private host names and suffixes", () => {
    for (const host of [
      "localhost",
      "air",
      "printer.local",
      "api.internal",
      "router.home.arpa",
      "home.arpa",
      "box.tailnet.ts.net",
      "AIR.TAILE8BEA7.TS.NET",
    ]) {
      expect(isPublicFaviconHost(host), host).toBe(false);
    }
  });

  it("detects private IPv6 addresses", () => {
    for (const host of ["::1", "[::1]", "fd00::1", "fc00::1", "fe80::1", "FD12:3456::1"]) {
      expect(isPublicFaviconHost(host), host).toBe(false);
    }
    expect(isPublicFaviconHost("2606:4700:4700::1111")).toBe(true);
  });

  it("detects IPv4-mapped IPv6 addresses in both spellings", () => {
    for (const host of [
      "::ffff:192.168.1.10",
      "::ffff:10.0.0.1",
      "::ffff:100.126.17.15",
      "[::ffff:192.168.1.10]",
      // c0a8:010a is 192.168.1.10, 0a00:0001 is 10.0.0.1.
      "::ffff:c0a8:010a",
      "::ffff:a00:1",
    ]) {
      expect(isPublicFaviconHost(host), host).toBe(false);
    }
    expect(isPublicFaviconHost("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicFaviconHost("::ffff:808:808")).toBe(true);
  });

  it("ignores a trailing DNS root label", () => {
    for (const host of [
      "localhost.",
      "printer.local.",
      "api.internal.",
      "box.tailnet.ts.net.",
      "air.",
    ]) {
      expect(isPublicFaviconHost(host), host).toBe(false);
    }
    expect(isPublicFaviconHost("github.com.")).toBe(true);
  });

  it("detects names under .localhost", () => {
    for (const host of ["app.localhost", "api.app.localhost", "APP.LOCALHOST"]) {
      expect(isPublicFaviconHost(host), host).toBe(false);
    }
  });

  it("treats an empty host as private", () => {
    expect(isPublicFaviconHost("")).toBe(false);
    expect(isPublicFaviconHost("   ")).toBe(false);
  });

  it("rejects malformed IPv4 text as a public host", () => {
    expect(isPublicFaviconHost("10.0.0.999")).toBe(true);
    expect(isPublicFaviconHost("10.0.0")).toBe(true);
  });
});
