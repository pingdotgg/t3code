import * as net from "node:net";

import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Net from "@t3tools/shared/Net";
import { Effect, Layer } from "effect";

import { ProcessRunner, ProcessSpawnError } from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";

const { parseLsofOutput, parsePortFromLsofName, parseWindowsListenerOutput, serversEqual } =
  PortScanner.__testing;
const TestProcessRunner = Layer.succeed(ProcessRunner, {
  run: (input) =>
    Effect.fail(
      new ProcessSpawnError({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        cause: "process command unavailable in fallback test",
      }),
    ),
});
const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      TestProcessRunner,
      Net.layer,
      Layer.succeed(PortScanner.CurrentPlatform, "win32"),
    ),
  ),
);

const openServer = (port: number): Effect.Effect<net.Server | null> =>
  Effect.callback((resume) => {
    const server = net.createServer();
    server.once("error", () => {
      resume(Effect.succeed(null));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(server));
    });
    return Effect.sync(() => {
      server.close();
    });
  });

const closeServer = (server: net.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
) {
  for (const port of ports) {
    const server = yield* openServer(port);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS),
  ({ server }) => closeServer(server),
);

describe("parsePortFromLsofName", () => {
  it("parses *:port", () => {
    assert.equal(parsePortFromLsofName("*:5173"), 5173);
  });

  it("parses 127.0.0.1:port", () => {
    assert.equal(parsePortFromLsofName("127.0.0.1:5173"), 5173);
  });

  it("parses localhost:port", () => {
    assert.equal(parsePortFromLsofName("localhost:5173"), 5173);
  });

  it("parses [::1]:port", () => {
    assert.equal(parsePortFromLsofName("[::1]:5173"), 5173);
  });

  it("ignores non-local hosts", () => {
    assert.equal(parsePortFromLsofName("192.168.1.10:5173"), null);
  });

  it("strips trailing description", () => {
    assert.equal(parsePortFromLsofName("*:5173 (LISTEN)"), 5173);
  });

  it("rejects garbage", () => {
    assert.equal(parsePortFromLsofName(""), null);
    assert.equal(parsePortFromLsofName("not-a-port"), null);
    assert.equal(parsePortFromLsofName("*:0"), null);
    assert.equal(parsePortFromLsofName("*:99999"), null);
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
    assert.deepStrictEqual(servers, [
      {
        host: "localhost",
        port: 3000,
        url: "http://localhost:3000",
        processName: "next-server",
        pid: 67890,
        terminal: null,
      },
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173",
        processName: "node",
        pid: 12345,
        terminal: null,
      },
      {
        host: "localhost",
        port: 9229,
        url: "http://localhost:9229",
        processName: "next-server",
        pid: 67890,
        terminal: null,
      },
    ]);
  });

  it("handles empty input", () => {
    assert.deepStrictEqual(parseLsofOutput(""), []);
  });

  it("dedupes by host:port", () => {
    const sample = ["p1", "cnode", "n*:5173", "n127.0.0.1:5173"].join("\n");
    const servers = parseLsofOutput(sample);
    assert.equal(servers.length, 1);
    assert.equal(servers[0]?.port, 5173);
  });

  it("attributes listeners to a registered terminal process", () => {
    const servers = parseLsofOutput(
      ["p12345", "cnode", "n*:5173"].join("\n"),
      new Map([
        [
          12345,
          {
            threadId: ThreadId.make("thread-1"),
            terminalId: "terminal-1",
          },
        ],
      ]),
    );

    assert.deepStrictEqual(servers[0]?.terminal, {
      threadId: "thread-1",
      terminalId: "terminal-1",
    });
  });
});

describe("serversEqual", () => {
  const a = {
    host: "localhost",
    port: 5173,
    url: "http://localhost:5173",
    processName: "node",
    pid: 1,
    terminal: null,
  };
  it("returns true for identical lists", () => {
    assert.equal(serversEqual([a], [{ ...a }]), true);
  });
  it("returns false for different lengths", () => {
    assert.equal(serversEqual([a], []), false);
  });
  it("returns false for different processName", () => {
    assert.equal(serversEqual([a], [{ ...a, processName: "other" }]), false);
  });
});

describe("parseWindowsListenerOutput", () => {
  it("parses and attributes PowerShell listener records", () => {
    const servers = parseWindowsListenerOutput(
      "0.0.0.0|5173|12345|node",
      new Map([
        [
          12345,
          {
            threadId: ThreadId.make("thread-1"),
            terminalId: "terminal-1",
          },
        ],
      ]),
    );

    assert.deepStrictEqual(servers, [
      {
        host: "localhost",
        port: 5173,
        url: "http://localhost:5173",
        processName: "node",
        pid: 12345,
        terminal: {
          threadId: "thread-1",
          terminalId: "terminal-1",
        },
      },
    ]);
  });
});

/**
 * Integration tests against a real TCP listener. The test layer forces the
 * Windows code path (TCP-probe fallback) so we don't depend on `lsof` being
 * installed.
 */
it.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns a server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      assert.notEqual(found, undefined);
      assert.equal(found?.host, "localhost");
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe((servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      assert.isTrue(received.includes(port));
    }),
  );
});
