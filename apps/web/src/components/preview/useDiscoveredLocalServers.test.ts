import type { DiscoveredLocalServer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeServers } from "./useDiscoveredLocalServers";

const scannerServer = (
  overrides: Partial<DiscoveredLocalServer & { requestedUrl: string }>,
): DiscoveredLocalServer & { requestedUrl: string } => ({
  host: "localhost",
  port: 5173,
  url: "http://localhost:5173",
  requestedUrl: overrides.url ?? "http://localhost:5173",
  processName: "vite",
  pid: 1234,
  terminal: null,
  ...overrides,
});

describe("mergeServers", () => {
  it("enriches a configured entry with live process metadata when scanner sees it", () => {
    const result = mergeServers({
      scanner: [scannerServer({ port: 5173, processName: "node", pid: 9999 })],
      configuredUrls: ["http://localhost:5173"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      port: 5173,
      source: "configured",
      processName: "node",
      pid: 9999,
    });
  });

  it("excludes configured entries that the live scanner doesn't see", () => {
    const result = mergeServers({
      scanner: [],
      configuredUrls: ["http://localhost:5173"],
    });
    expect(result).toHaveLength(0);
  });

  it("ignores non-loopback configured URLs", () => {
    const result = mergeServers({
      scanner: [scannerServer({})],
      configuredUrls: ["https://example.com", "ws://localhost:5173"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe("scanner");
  });

  it.each(["127.0.0.1", "0.0.0.0", "[::1]"])(
    "matches configured loopback alias %s to a live localhost server",
    (host) => {
      const result = mergeServers({
        scanner: [
          scannerServer({ requestedUrl: `http://localhost:5173/dashboard?mode=test#results` }),
        ],
        configuredUrls: [`http://${host}:5173/dashboard?mode=test#results`],
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.source).toBe("configured");
      expect(result[0]?.requestedUrl).toBe("http://localhost:5173/dashboard?mode=test#results");
    },
  );

  it("keeps the scanner-verified path and protocol", () => {
    const result = mergeServers({
      scanner: [
        scannerServer({
          url: "https://env-42.example.dev:5173/",
          requestedUrl: "http://localhost:5173/dashboard?mode=test#results",
        }),
      ],
      configuredUrls: ["https://localhost:5173/dashboard?mode=test#results"],
    });
    expect(result[0]?.url).toBe("https://env-42.example.dev:5173/");
    expect(result[0]?.requestedUrl).toBe("http://localhost:5173/dashboard?mode=test#results");
  });

  it("overlays a configured path when an older server does not advertise path probing", () => {
    const result = mergeServers({
      scanner: [scannerServer({ requestedUrl: "http://localhost:5173/" })],
      configuredUrls: ["https://localhost:5173/docs?mode=test#results"],
      configuredUrlProbing: false,
    });

    expect(result[0]?.requestedUrl).toBe("https://localhost:5173/docs?mode=test#results");
  });

  it("does not overlay an unverified configured path when the server probes paths", () => {
    const result = mergeServers({
      scanner: [scannerServer({ requestedUrl: "http://localhost:5173/" })],
      configuredUrls: ["http://localhost:5173/docs"],
      configuredUrlProbing: true,
    });

    expect(result[0]?.requestedUrl).toBe("http://localhost:5173/");
  });
});
