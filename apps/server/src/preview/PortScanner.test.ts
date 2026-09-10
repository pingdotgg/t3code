import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  ThreadId,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Net from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";
import { FetchHttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";
const processProbeFailure: ProcessRunner.ProcessRunner["Service"]["run"] = (input) =>
  Effect.fail(
    new ProcessRunner.ProcessSpawnError({
      command: input.command,
      argumentCount: input.args.length,
      cwd: input.cwd,
      cause: PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "PowerShell is not installed in the test environment",
      }),
    }),
  );

const TestProcessRunner = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: processProbeFailure,
});

let integrationListeningPort: number | null = null;

const TestIntegrationNet = Layer.succeed(Net.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: (port) => Effect.sync(() => port !== integrationListeningPort),
  hasListenerOnHost: (port) => Effect.sync(() => port === integrationListeningPort),
  reserveLoopbackPort: () => Effect.succeed(40_000),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

const makeProbeFailureLayer = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessEnvironment, {}),
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const TestPortDiscoveryLive = PortScanner.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HostProcessEnvironment, {}),
      TestProcessRunner,
      TestIntegrationNet,
      Layer.succeed(HostProcessPlatform, "win32"),
      FetchHttpClient.layer,
    ),
  ),
);

const LSOF_TEST_PORT = 43_123;

const makeLsofScannerLayer = (input: {
  readonly pid: () => number;
  readonly fetch: typeof globalThis.fetch;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(HostProcessEnvironment, {}),
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(Net.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(false),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        Layer.succeed(HostProcessPlatform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

describe("Portless route enrichment", () => {
  it("uses the live Portless URL for its target listener", () => {
    const routes = PortScanner.__testing.parsePortlessRouteSnapshot({
      routesJson: JSON.stringify([
        {
          hostname: "eng-1252-simplify-the-onboarding.artelo.localhost",
          port: 4058,
          pid: 123,
        },
      ]),
      proxyPortRaw: "443\n",
      tls: true,
      proxyListening: true,
      isProcessAlive: (pid) => pid === 123,
    });

    expect(routes.get(4058)).toEqual({
      url: "https://eng-1252-simplify-the-onboarding.artelo.localhost",
      urlKind: "local-proxy",
    });
    expect(
      PortScanner.__testing.applyNamedRoutes(
        [
          {
            host: "localhost",
            port: 4058,
            url: "http://localhost:4058",
            processName: "node",
            pid: 456,
            terminal: null,
          },
        ],
        routes,
      ),
    ).toEqual([
      {
        host: "localhost",
        port: 4058,
        url: "https://eng-1252-simplify-the-onboarding.artelo.localhost",
        urlKind: "local-proxy",
        processName: "node",
        pid: 456,
        terminal: null,
      },
    ]);
  });

  it("ignores stale routes and preserves custom proxy settings", () => {
    const routes = PortScanner.__testing.parsePortlessRouteSnapshot({
      routesJson: JSON.stringify([
        { hostname: "stale.localhost", port: 3000, pid: 111 },
        { hostname: "current.test", port: 3001, pid: 222 },
        { hostname: "not a hostname", port: 3002, pid: 222 },
      ]),
      proxyPortRaw: "8080",
      tls: false,
      proxyListening: true,
      isProcessAlive: (pid) => pid === 222,
    });

    expect([...routes]).toEqual([
      [3001, { url: "http://current.test:8080", urlKind: "local-proxy" }],
    ]);
  });

  it.each(["8080abc", "443.5"])("ignores a malformed proxy port of %s", (proxyPortRaw) => {
    const routes = PortScanner.__testing.parsePortlessRouteSnapshot({
      routesJson: JSON.stringify([{ hostname: "current.test", port: 3001, pid: 222 }]),
      proxyPortRaw,
      tls: true,
      proxyListening: true,
      isProcessAlive: (pid) => pid === 222,
    });

    expect([...routes]).toEqual([[3001, { url: "https://current.test", urlKind: "local-proxy" }]]);
  });

  it("ignores routes when the Portless proxy is no longer listening", () => {
    const routes = PortScanner.__testing.parsePortlessRouteSnapshot({
      routesJson: JSON.stringify([{ hostname: "stale.localhost", port: 3001, pid: 222 }]),
      proxyPortRaw: "443",
      tls: true,
      proxyListening: false,
      isProcessAlive: () => true,
    });

    expect([...routes]).toEqual([]);
  });
});

describe("ngrok route enrichment", () => {
  it("maps public HTTP tunnels to their loopback target and prefers HTTPS", () => {
    const routes = PortScanner.__testing.parseNgrokTunnelSnapshot({
      tunnels: [
        {
          public_url: "http://feature.ngrok-free.app",
          config: { addr: "http://localhost:4058" },
        },
        {
          public_url: "https://feature.ngrok-free.app",
          config: { addr: "http://127.0.0.1:4058" },
        },
      ],
    });

    expect(routes && [...routes]).toEqual([
      [4058, { url: "https://feature.ngrok-free.app/", urlKind: "public-tunnel" }],
    ]);
  });

  it("accepts current forwards_to entries and ignores unsafe or non-web tunnels", () => {
    const routes = PortScanner.__testing.parseNgrokTunnelSnapshot({
      tunnels: [
        { public_url: "https://docs.example.com", forwards_to: "[::1]:4312" },
        { public_url: "https://invalid.example.com", forwards_to: "internal.example.com:4313" },
        { public_url: "tcp://1.tcp.ngrok.io:12345", config: { addr: "localhost:4314" } },
        { public_url: "https://user:secret@example.com", config: { addr: "4315" } },
      ],
    });

    expect(routes && [...routes]).toEqual([
      [4312, { url: "https://docs.example.com/", urlKind: "public-tunnel" }],
    ]);
  });

  it("returns null when the agent response does not match the tunnel list contract", () => {
    expect(PortScanner.__testing.parseNgrokTunnelSnapshot({ tunnels: "invalid" })).toBeNull();
  });

  it("keeps app terminal ownership when ngrok runs in another terminal", () => {
    const appTerminal = { threadId: ThreadId.make("thread-app"), terminalId: "term-app" } as const;
    const ngrokTerminal = {
      threadId: ThreadId.make("thread-ngrok"),
      terminalId: "term-ngrok",
    } as const;
    const [server] = PortScanner.__testing.applyNamedRoutes(
      [
        {
          host: "localhost",
          port: 4058,
          url: "http://localhost:4058",
          processName: "node",
          pid: 456,
          terminal: appTerminal,
        },
      ],
      new Map([
        [
          4058,
          {
            url: "https://feature.ngrok-free.app/",
            urlKind: "public-tunnel" as const,
            terminal: ngrokTerminal,
          },
        ],
      ]),
    );

    expect(server?.terminal).toEqual(appTerminal);
    expect(server?.url).toBe("https://feature.ngrok-free.app/");
  });
});

describe("Tailscale Serve route enrichment", () => {
  it("maps legacy Serve routes to their loopback targets and prefers HTTPS", () => {
    const routes = PortScanner.__testing.parseTailscaleServeStatus(
      JSON.stringify({
        TCP: {
          80: { HTTP: true },
          443: { HTTPS: true },
        },
        Web: {
          "desktop.example-tailnet.ts.net:80": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:4058" } },
          },
          "desktop.example-tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "https+insecure://localhost:4058" } },
          },
        },
      }),
    );

    expect([...routes]).toEqual([
      [
        4058,
        {
          url: "https://desktop.example-tailnet.ts.net/",
        },
      ],
    ]);
  });

  it("supports Tailscale Services and preserves a non-root mount", () => {
    const routes = PortScanner.__testing.parseTailscaleServeStatus(
      JSON.stringify({
        Services: {
          "svc:docs": {
            TCP: { 8443: { HTTPS: true } },
            Web: {
              "docs.example-tailnet.ts.net:8443": {
                Handlers: { "/preview": { Proxy: "http://[::1]:4312/docs" } },
              },
            },
          },
        },
      }),
    );

    expect([...routes]).toEqual([
      [
        4312,
        {
          url: "https://docs.example-tailnet.ts.net:8443/preview",
        },
      ],
    ]);
  });

  it("maps foreground Serve routes", () => {
    const routes = PortScanner.__testing.parseTailscaleServeStatus(
      JSON.stringify({
        Foreground: {
          "session-1": {
            TCP: { 443: { HTTPS: true } },
            Web: {
              "desktop.example-tailnet.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } },
              },
            },
          },
        },
      }),
    );

    expect([...routes]).toEqual([
      [
        5173,
        {
          url: "https://desktop.example-tailnet.ts.net/",
        },
      ],
    ]);
  });

  it("ignores malformed, credentialed, non-tailnet, and non-loopback routes", () => {
    const routes = PortScanner.__testing.parseTailscaleServeStatus(
      JSON.stringify({
        TCP: { 443: { HTTPS: true } },
        Web: {
          "user:secret@desktop.example-tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://localhost:3000" } },
          },
          "public.example.com:443": {
            Handlers: { "/": { Proxy: "http://localhost:3001" } },
          },
          "desktop.example-tailnet.ts.net:443": {
            Handlers: {
              "//redirect": { Proxy: "http://localhost:3002" },
              "/": { Proxy: "http://internal.example.com:3003" },
            },
          },
        },
      }),
    );

    expect([...routes]).toEqual([]);
    expect(PortScanner.__testing.parseTailscaleServeStatus("not json").size).toBe(0);
  });
});

effectIt.effect("replaces a discovered listener with its ngrok public URL", () => {
  const targetPort = 43_127;
  const configuredUrl = `http://localhost:${targetPort}/docs?mode=test#results`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    if (url === "http://localhost:4040/api/tunnels") {
      return Promise.resolve(
        Response.json({
          tunnels: [
            {
              public_url: "https://feature.ngrok-free.app",
              config: { addr: `http://localhost:${targetPort}` },
            },
          ],
        }),
      );
    }
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(
    () =>
      Effect.succeed({
        stdout: `p1234\ncnode\nn*:${targetPort}\np5678\ncngrok\nn127.0.0.1:4040\n`,
        stderr: "",
        code: null,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
    fetchFn,
  );

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-ngrok",
      terminalId: "term-ngrok",
      processIds: [5678],
    });
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers.map((server) => [server.port, server.url, server.urlKind])).toEqual([
      [targetPort, "https://feature.ngrok-free.app/docs?mode=test#results", "public-tunnel"],
    ]);
    expect(servers[0]?.terminal).toEqual({
      threadId: "thread-ngrok",
      terminalId: "term-ngrok",
    });
    expect(requests).toContain("http://localhost:4040/api/tunnels");
    expect(requests).toContain(configuredUrl);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("replaces a discovered listener with its Tailscale Serve URL", () => {
  const targetPort = 43_128;
  const configuredUrl = `http://localhost:${targetPort}/docs?mode=test#results`;
  let tailscaleStatusRuns = 0;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
    Promise.resolve(
      String(input) === configuredUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    )) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer((input) => {
    if (input.command === "tailscale") tailscaleStatusRuns += 1;
    return Effect.succeed({
      stdout:
        input.command === "tailscale"
          ? JSON.stringify({
              TCP: { 443: { HTTPS: true } },
              Web: {
                "desktop.example-tailnet.ts.net:443": {
                  Handlers: { "/preview": { Proxy: `http://localhost:${targetPort}` } },
                },
              },
            })
          : `p1234\ncnode\nn*:${targetPort}\n`,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
  }, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "thread-tailscale",
      terminalId: "term-dev-server",
      processIds: [1234],
    });
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers.map((server) => [server.port, server.url, server.urlKind])).toEqual([
      [
        targetPort,
        "https://desktop.example-tailnet.ts.net/preview/docs?mode=test#results",
        undefined,
      ],
    ]);
    expect(servers[0]?.terminal).toEqual({
      threadId: "thread-tailscale",
      terminalId: "term-dev-server",
    });
    expect(yield* scanner.scan([configuredUrl])).toEqual(servers);
    expect(tailscaleStatusRuns).toBe(1);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("keeps a non-ngrok web server on the default agent port", () => {
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
    Promise.resolve(
      String(input) === "http://localhost:4040/api/tunnels"
        ? Response.json({ tunnels: [] })
        : new Response("app", { headers: { "content-type": "text/html" } }),
    )) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(
    () =>
      Effect.succeed({
        stdout: "p1234\ncnode\nn*:4040\n",
        stderr: "",
        code: null,
        timedOut: false,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
        stderrInvalidUtf8: false,
      }),
    fetchFn,
  );

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toMatchObject([{ port: 4040, url: "http://localhost:4040" }]);
  }).pipe(Effect.provide(layer));
});

const openServer = (
  port: number,
  onConnection: (socket: NodeNet.Socket) => void,
): Effect.Effect<NodeNet.Server | null> =>
  Effect.callback((resume) => {
    const server = NodeNet.createServer(onConnection);
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

const closeServer = (server: NodeNet.Server): Effect.Effect<void> =>
  Effect.callback((resume) => {
    server.close(() => resume(Effect.void));
  });

const openCommonDevServer = Effect.fn("PortScannerTest.openCommonDevServer")(function* (
  ports: ReadonlyArray<number>,
  onConnection: (socket: NodeNet.Socket) => void,
) {
  for (const port of ports) {
    const server = yield* openServer(port, onConnection);
    if (server !== null) return { port, server };
  }
  return yield* Effect.die(
    new Error("No common development port was available for the preview scanner test"),
  );
});

const commonDevServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS, (socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 5\r\n\r\nhello");
    });
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

const commonNonHttpServer = Effect.acquireRelease(
  openCommonDevServer(PortScanner.COMMON_DEV_PORTS.toReversed(), (socket) => {
    socket.on("error", () => undefined);
    socket.once("data", () => socket.end("MYSQL\r\n\r\n"));
  }).pipe(
    Effect.tap(({ port }) =>
      Effect.sync(() => {
        integrationListeningPort = port;
      }),
    ),
  ),
  ({ server }) =>
    closeServer(server).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          integrationListeningPort = null;
        }),
      ),
    ),
);

/**
 * Integration tests against a real TCP listener. We provide the Windows host
 * platform so the tests exercise the TCP-probe fallback without depending on
 * `lsof` being installed.
 */
effectIt.layer(TestPortDiscoveryLive)("PortDiscovery integration (TCP probe fallback)", (it) => {
  it.effect(
    "scan() returns an HTTP server we just opened on a curated dev port",
    Effect.fn("PortScannerTest.scanFindsCommonDevServer")(function* () {
      const { port } = yield* commonDevServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      const found = result.find((server) => server.port === port);
      expect(found).toBeDefined();
      expect(found?.host).toBe("localhost");
    }),
  );

  it.effect(
    "scan() excludes a listening port that does not speak HTTP",
    Effect.fn("PortScannerTest.scanExcludesNonHttpServer")(function* () {
      const { port } = yield* commonNonHttpServer;
      const scanner = yield* PortScanner.PortDiscovery;
      const result = yield* scanner.scan();
      expect(result.some((server) => server.port === port)).toBe(false);
    }),
  );

  it.effect(
    "retain drives an immediate broadcast to subscribers",
    Effect.fn("PortScannerTest.retainBroadcastsImmediately")(function* () {
      const { port } = yield* commonDevServer;
      const received: number[] = [];
      const scanner = yield* PortScanner.PortDiscovery;
      yield* scanner.subscribe({ configuredUrls: [], initialSnapshot: [] }, (servers) =>
        Effect.sync(() => {
          for (const server of servers) received.push(server.port);
        }),
      );
      yield* scanner.retain;
      expect(received).toContain(port);
    }),
  );
});

effectIt.effect("revalidates a successful HTML probe after its cache entry expires", () => {
  let responds = true;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);

    responds = false;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("keeps a full configured URL when the discovered server root fails", () => {
  const requests: string[] = [];
  const configuredUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === configuredUrl
        ? new Response("docs", { headers: { "content-type": "text/html" } })
        : new Response("not found", {
            status: 404,
            headers: { "content-type": "text/html" },
          }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(configuredUrl);
    expect(requests).toContain(configuredUrl);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("does not duplicate configured paths across loopback aliases", () => {
  const configuredUrl = `http://127.0.0.1:${LSOF_TEST_PORT}/docs`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
    Promise.resolve(
      new Response(String(input), { headers: { "content-type": "text/html" } }),
    )) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);

    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(configuredUrl);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("probes configured custom ports through a canonical loopback host", () => {
  const customPort = 43_124;
  const configuredUrl = `http://0.0.0.0:${customPort}/docs`;
  const expectedUrl = `http://localhost:${customPort}/docs`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.host).toBe("localhost");
    expect(servers[0]?.port).toBe(customPort);
    expect(servers[0]?.url).toBe(expectedUrl);
    expect(requests).toEqual([expectedUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("preserves explicit loopback hosts and bounds wildcard rewrites", () => {
  const ipv4Url = "https://127.0.0.1:43125/docs";
  const ipv6Url = "http://[::1]:43126/docs";
  const wildcardPrefix = "http://0.0.0.0/";
  const maximumWildcardUrl = `${wildcardPrefix}${"a".repeat(
    PREVIEW_URL_MAX_LENGTH - wildcardPrefix.length,
  )}`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeProbeFailureLayer(processProbeFailure, fetchFn);

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([ipv4Url, ipv6Url, maximumWildcardUrl]);
    expect(servers.map((server) => server.url)).toEqual([ipv4Url, ipv6Url]);
    expect(requests).toEqual([ipv4Url, ipv6Url]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("projects configured paths independently for simultaneous subscribers", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    const adminSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
    yield* scanner.subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => docsSnapshots.push(servers)),
    );
    yield* scanner.subscribe({ configuredUrls: [adminUrl], initialSnapshot: [] }, (servers) =>
      Effect.sync(() => adminSnapshots.push(servers)),
    );
    yield* scanner.retain;

    expect(docsSnapshots.at(-1)?.[0]?.url).toBe(docsUrl);
    expect(adminSnapshots.at(-1)?.[0]?.url).toBe(adminUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect(
  "keeps each subscriber's candidates when their combined union exceeds the per-client cap",
  () => {
    const firstSubscriberUrls = Array.from(
      { length: CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS },
      (_, index) => `http://localhost:${LSOF_TEST_PORT}/app-${index}`,
    );
    const secondSubscriberUrl = `http://localhost:${LSOF_TEST_PORT}/app-${CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS}`;
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(
        String(input) === secondSubscriberUrl
          ? new Response("app", { headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 }),
      )) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      const secondSnapshots: ReadonlyArray<DiscoveredLocalServer>[] = [];
      yield* scanner.subscribe(
        { configuredUrls: firstSubscriberUrls, initialSnapshot: [] },
        () => Effect.void,
      );
      yield* scanner.subscribe(
        { configuredUrls: [secondSubscriberUrl], initialSnapshot: [] },
        (servers) => Effect.sync(() => secondSnapshots.push(servers)),
      );
      yield* scanner.retain;

      expect(secondSnapshots.at(-1)?.[0]?.url).toBe(secondSubscriberUrl);
    }).pipe(Effect.scoped, Effect.provide(layer));
  },
);

effectIt.effect("stops probing a subscriber's configured paths after its scope closes", () => {
  const docsUrl = `http://localhost:${LSOF_TEST_PORT}/docs`;
  const adminUrl = `http://localhost:${LSOF_TEST_PORT}/admin`;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return Promise.resolve(
      url === docsUrl || url === adminUrl
        ? new Response("app", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    );
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const docsScope = yield* Scope.make();
    yield* scanner
      .subscribe({ configuredUrls: [docsUrl], initialSnapshot: [] }, () => Effect.void)
      .pipe(Effect.provideService(Scope.Scope, docsScope));
    yield* scanner.subscribe(
      { configuredUrls: [adminUrl], initialSnapshot: [] },
      () => Effect.void,
    );
    yield* scanner.retain;
    yield* Scope.close(docsScope, Exit.void);

    requests.length = 0;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(requests).toContain(adminUrl);
    expect(requests).not.toContain(docsUrl);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

effectIt.effect("uses the current configured fragment when readiness comes from cache", () => {
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("docs", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });
  const oldUrl = `http://localhost:${LSOF_TEST_PORT}/docs#old`;
  const newUrl = `http://localhost:${LSOF_TEST_PORT}/docs#new`;

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect((yield* scanner.scan([oldUrl]))[0]?.url).toBe(oldUrl);
    const requestCount = requests.length;
    expect((yield* scanner.scan([newUrl]))[0]?.url).toBe(newUrl);
    expect(requests).toHaveLength(requestCount);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("shares a configured root probe with discovered-root classification", () => {
  const requests: string[] = [];
  const rootUrl = `http://localhost:${LSOF_TEST_PORT}/`;
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl]);

    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan([rootUrl])).toHaveLength(1);
    expect(requests).toEqual([rootUrl, rootUrl]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("starts fresh cache entries after the probing batch completes", () =>
  Effect.gen(function* () {
    const baseClock = yield* Clock.Clock;
    const times = [0, 20_000, 20_000, 20_000];
    let timeIndex = 0;
    const currentTimeMillis = () => times[Math.min(timeIndex++, times.length - 1)]!;
    const clock: Clock.Clock = {
      ...baseClock,
      currentTimeMillisUnsafe: currentTimeMillis,
      currentTimeMillis: Effect.sync(currentTimeMillis),
    };
    const requests: string[] = [];
    const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
      requests.push(String(input));
      return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
    }) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

    yield* Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(yield* scanner.scan()).toHaveLength(1);
      expect(requests).toHaveLength(1);
    }).pipe(Effect.provide(layer), Effect.provideService(Clock.Clock, clock));
  }),
);

effectIt.effect("caches a failed web probe until its bounded cache entry expires", () => {
  let responds = false;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return responds
      ? Promise.resolve(new Response("hello", { headers: { "content-type": "text/html" } }))
      : Promise.reject(new TypeError("not HTTP"));
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toHaveLength(2);

    responds = true;
    yield* TestClock.adjust(Duration.seconds(15));
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toHaveLength(3);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("falls back to HTTPS and does not follow redirects while probing", () => {
  const redirects: Array<string | undefined> = [];
  const fetchFn = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    redirects.push(init?.redirect);
    if (String(input).startsWith("http:")) throw new TypeError("TLS listener");
    return new Response(null, { status: 302, headers: { location: "https://example.com" } });
  }) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(`https://localhost:${LSOF_TEST_PORT}`);
    expect(redirects).toEqual(["manual", "manual"]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect(
  "excludes HTTP errors, non-navigation responses, and successful non-documents",
  () => {
    let pid = 1;
    let makeResponse = () =>
      new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
    const fetchFn = ((_input: Parameters<typeof globalThis.fetch>[0]) =>
      Promise.resolve(makeResponse())) as typeof globalThis.fetch;
    const layer = makeLsofScannerLayer({ pid: () => pid, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("ready", { status: 200, headers: { "content-type": "text/plain" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 304, headers: { location: "/cached" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response(null, { status: 204, headers: { "content-type": "text/html" } });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () => new Response(null, { status: 302 });
      expect(yield* scanner.scan()).toHaveLength(0);

      pid += 1;
      makeResponse = () =>
        new Response("<html />", {
          status: 200,
          headers: { "content-type": "application/xhtml+xml; charset=utf-8" },
        });
      expect(yield* scanner.scan()).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("aborts HTTP and HTTPS probes when they time out", () => {
  const aborted: string[] = [];
  const fetchFn = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        aborted.push(String(input));
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
    })) as typeof globalThis.fetch;
  const layer = makeLsofScannerLayer({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const scanFiber = yield* Effect.forkChild(scanner.scan());
    yield* TestClock.adjust(Duration.seconds(2));
    expect(yield* Fiber.join(scanFiber)).toHaveLength(0);
    expect(aborted).toEqual([
      `http://localhost:${LSOF_TEST_PORT}/`,
      `https://localhost:${LSOF_TEST_PORT}/`,
    ]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("does not swallow process probe defects", () =>
  Effect.gen(function* () {
    const defect = new Error("unexpected process probe defect");
    const layer = makeProbeFailureLayer(() => Effect.die(defect));

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.squash(exit.cause)).toBe(defect);
    }
  }),
);

effectIt.effect("does not swallow process probe interruption", () =>
  Effect.gen(function* () {
    const layer = makeProbeFailureLayer(() => Effect.interrupt);

    const exit = yield* Effect.flatMap(PortScanner.PortDiscovery, (scanner) => scanner.scan()).pipe(
      Effect.provide(layer),
      Effect.exit,
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  }),
);
