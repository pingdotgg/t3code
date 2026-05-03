import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { mergeServers, type PreviewableServer } from "./useDiscoveredLocalServers";

const scannerServer = (overrides: Partial<DiscoveredLocalServer>): DiscoveredLocalServer => ({
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  processName: "vite",
  pid: 1234,
  ...overrides,
});

describe("mergeServers", () => {
  it("returns scanner-only entries unchanged", () => {
    const result = mergeServers({
      scanner: [scannerServer({})],
      configuredUrls: [],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      host: "localhost",
      port: 5173,
      source: "scanner",
      listening: true,
      processName: "vite",
    });
  });

  it("enriches a configured entry with live process metadata when scanner sees it", () => {
    const result = mergeServers({
      scanner: [scannerServer({ port: 5173, processName: "node", pid: 9999 })],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      port: 5173,
      source: "configured",
      listening: true,
      processName: "node",
      pid: 9999,
    });
  });

  it("keeps configured entries that the scanner doesn't see, with listening=false", () => {
    const result = mergeServers({
      scanner: [],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source: "configured",
      listening: false,
    });
  });

  it("dedupes recently-seen URLs against scanner+configured entries", () => {
    const result = mergeServers({
      scanner: [scannerServer({ port: 5173 })],
      configuredUrls: [],
      recentlySeenUrls: ["http://localhost:5173/", "http://localhost:8080/"],
    });
    expect(result.map((s) => s.port)).toEqual([5173, 8080]);
    expect(result.find((s) => s.port === 5173)?.source).toBe("scanner");
    expect(result.find((s) => s.port === 8080)?.source).toBe("recent");
  });

  it("ignores non-loopback URLs in configured/recent inputs", () => {
    const result = mergeServers({
      scanner: [],
      configuredUrls: ["https://example.com", "ws://localhost:5173"],
      recentlySeenUrls: ["https://api.example.com"],
    });
    expect(result).toHaveLength(0);
  });

  it("sorts: configured before scanner before recent, then by port", () => {
    const result = mergeServers({
      scanner: [scannerServer({ port: 8080 }), scannerServer({ port: 3000 })],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: ["http://localhost:9000/", "http://localhost:4321/"],
    });
    expect(result.map((s) => `${s.source}:${s.port}`)).toEqual([
      "configured:5173",
      "scanner:3000",
      "scanner:8080",
      "recent:4321",
      "recent:9000",
    ]);
  });

  it("dedupes by lowercased host", () => {
    const result = mergeServers({
      scanner: [scannerServer({ host: "Localhost", port: 5173 })],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: [],
    });
    expect(result).toHaveLength(1);
  });
});

describe("PreviewableServer interface", () => {
  it("preserves listening flag through enrichment", () => {
    const result = mergeServers({
      scanner: [scannerServer({})],
      configuredUrls: ["http://localhost:5173"],
      recentlySeenUrls: [],
    });
    const merged: PreviewableServer | undefined = result[0];
    expect(merged?.listening).toBe(true);
  });
});
