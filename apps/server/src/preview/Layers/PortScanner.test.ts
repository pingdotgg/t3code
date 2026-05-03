import * as net from "node:net";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PreviewPortScanner } from "../Services/PortScanner.ts";
import { __testing, PreviewPortScannerLive } from "./PortScanner.ts";

const { parseLsofOutput, parsePortFromLsofName, serversEqual } = __testing;

describe("parsePortFromLsofName", () => {
  it("parses *:port", () => {
    expect(parsePortFromLsofName("*:5173")).toBe(5173);
  });

  it("parses 127.0.0.1:port", () => {
    expect(parsePortFromLsofName("127.0.0.1:5173")).toBe(5173);
  });

  it("parses localhost:port", () => {
    expect(parsePortFromLsofName("localhost:5173")).toBe(5173);
  });

  it("parses [::1]:port", () => {
    expect(parsePortFromLsofName("[::1]:5173")).toBe(5173);
  });

  it("ignores non-local hosts", () => {
    expect(parsePortFromLsofName("192.168.1.10:5173")).toBeNull();
  });

  it("strips trailing description", () => {
    expect(parsePortFromLsofName("*:5173 (LISTEN)")).toBe(5173);
  });

  it("rejects garbage", () => {
    expect(parsePortFromLsofName("")).toBeNull();
    expect(parsePortFromLsofName("not-a-port")).toBeNull();
    expect(parsePortFromLsofName("*:0")).toBeNull();
    expect(parsePortFromLsofName("*:99999")).toBeNull();
  });
});

describe("parseLsofOutput", () => {
  it("parses a typical lsof -F pcn output", () => {
    const sample = [
      "p12345",
      "cnode",
      "n*:5173",
      "p67890",
      "cnext-server",
      "n127.0.0.1:3000",
      "n127.0.0.1:9229", // node debug port too — same process
      "p13579",
      "cChrome",
      "n192.168.1.10:443", // not local — ignored
    ].join("\n");

    const servers = parseLsofOutput(sample);
    expect(servers).toEqual([
      {
        host: "localhost",
        port: 3000,
        url: "http://localhost:3000",
        processName: "next-server",
        pid: 67890,
      },
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173",
        processName: "node",
        pid: 12345,
      },
      {
        host: "localhost",
        port: 9229,
        url: "http://localhost:9229",
        processName: "next-server",
        pid: 67890,
      },
    ]);
  });

  it("handles empty input", () => {
    expect(parseLsofOutput("")).toEqual([]);
  });

  it("dedupes by host:port", () => {
    const sample = ["p1", "cnode", "n*:5173", "n127.0.0.1:5173"].join("\n");
    const servers = parseLsofOutput(sample);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.port).toBe(5173);
  });
});

describe("serversEqual", () => {
  const a = {
    host: "localhost",
    port: 5173,
    url: "http://localhost:5173",
    processName: "node",
    pid: 1,
  };
  it("returns true for identical lists", () => {
    expect(serversEqual([a], [{ ...a }])).toBe(true);
  });
  it("returns false for different lengths", () => {
    expect(serversEqual([a], [])).toBe(false);
  });
  it("returns false for different processName", () => {
    expect(serversEqual([a], [{ ...a, processName: "other" }])).toBe(false);
  });
});

/**
 * Integration tests against a real TCP listener. We force the Windows code
 * path (TCP-probe fallback) by monkey-patching `process.platform` for the
 * duration of the test so we don't depend on `lsof` being installed.
 */
describe("PreviewPortScanner integration (TCP probe path)", () => {
  let originalPlatform: NodeJS.Platform;
  let server: net.Server;

  beforeEach(async () => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    // 3001 is in COMMON_DEV_PORTS so the TCP-probe pass will check it.
    server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(3001, "127.0.0.1", () => resolve());
    });
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("scan() returns a server we just opened on a curated dev port", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scanner = yield* PreviewPortScanner;
          return yield* scanner.scan();
        }).pipe(Effect.provide(PreviewPortScannerLive)),
      ),
    );
    const found = result.find((s) => s.port === 3001);
    expect(found).toBeDefined();
    expect(found?.host).toBe("localhost");
  });

  it("retain() drives an immediate broadcast to subscribers", async () => {
    const received: number[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scanner = yield* PreviewPortScanner;
          const unsubscribe = yield* scanner.subscribe((servers) =>
            Effect.sync(() => {
              for (const server of servers) received.push(server.port);
            }),
          );
          const release = yield* scanner.retain();
          // The retain() pollTick is fire-and-forget within Effect, so wait
          // a frame for the broadcast to land.
          yield* Effect.sleep("100 millis");
          unsubscribe();
          release();
        }).pipe(Effect.provide(PreviewPortScannerLive)),
      ),
    );
    expect(received).toContain(3001);
  });
});
