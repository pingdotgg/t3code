import * as net from "node:net";

import { it as effectIt } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { COMMON_DEV_PORTS, PreviewPortScanner } from "../Services/PortScanner.ts";
import { ProcessRunner } from "../../processRunner.ts";
import { __testing, PreviewPortScannerLive } from "./PortScanner.ts";

const { parseLsofOutput, parsePortFromLsofName, serversEqual } = __testing;
const TestProcessRunner = Layer.succeed(ProcessRunner, {
  run: () => Effect.die("ProcessRunner should not be used by Windows TCP probe tests"),
});
const TestPreviewPortScannerLive = PreviewPortScannerLive.pipe(Layer.provide(TestProcessRunner));

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
  let port: number;

  beforeEach(async () => {
    originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    for (const candidate of COMMON_DEV_PORTS) {
      const candidateServer = net.createServer();
      const listening = await new Promise<boolean>((resolve) => {
        candidateServer.once("error", () => resolve(false));
        candidateServer.listen(candidate, "127.0.0.1", () => resolve(true));
      });
      if (listening) {
        server = candidateServer;
        port = candidate;
        return;
      }
      candidateServer.close();
    }
    throw new Error("No common development port was available for the preview scanner test");
  });

  afterEach(async () => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  effectIt.effect("scan() returns a server we just opened on a curated dev port", () =>
    Effect.gen(function* () {
      const scanner = yield* PreviewPortScanner;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }).pipe(Effect.provide(TestPreviewPortScannerLive)),
  );

  effectIt.effect("retain() drives an immediate broadcast to subscribers", () => {
    const received: number[] = [];
    return Effect.gen(function* () {
      const scanner = yield* PreviewPortScanner;
      const unsubscribe = yield* scanner.subscribe((servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      const release = yield* scanner.retain();
      unsubscribe();
      release();
      expect(received).toContain(port);
    }).pipe(Effect.provide(TestPreviewPortScannerLive));
  });
});
