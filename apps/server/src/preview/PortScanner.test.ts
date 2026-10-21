// @effect-diagnostics nodeBuiltinImport:off -- the stop test drives real server processes.
import * as NodeChildProcess from "node:child_process";

import { it as effectIt } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CONFIGURED_LOCAL_SERVER_URLS_MAX_ITEMS,
  PREVIEW_URL_MAX_LENGTH,
  type DiscoveredLocalServer,
} from "@t3tools/contracts";
import * as ProcessGroup from "@t3tools/provider-core/server/processGroup";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";
import { FetchHttpClient } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "./PortScanner.ts";

vi.mock("@t3tools/provider-core/server/processGroup", { spy: true });

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

const layerNoProc = FileSystem.layerNoop({});

const layerProbeFailure = (
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  fetch: typeof globalThis.fetch = globalThis.fetch,
  fileSystem: Layer.Layer<FileSystem.FileSystem> = layerNoProc,
) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fileSystem,
        Layer.succeed(ProcessRunner.ProcessRunner, { run }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      ),
    ),
  );

const LSOF_TEST_PORT = 43_123;

const ownedScanner = (processIds: ReadonlyArray<number> = [1234]) =>
  Effect.tap(PortScanner.PortDiscovery, (scanner) =>
    scanner.registerTerminalProcesses({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
      processIds,
    }),
  );

const layerLsofScanner = (input: {
  readonly pid: () => number;
  readonly fetch: typeof globalThis.fetch;
  readonly stdout?: () => string;
}) =>
  PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProc,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () =>
            Effect.succeed({
              stdout: input.stdout?.() ?? `p${input.pid()}\ncnode\nn*:${LSOF_TEST_PORT}\n`,
              stderr: "",
              code: null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, input.fetch)),
        ),
      ),
    ),
  );

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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    const servers = yield* scanner.scan([configuredUrl]);
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(configuredUrl);
    expect(requests).toContain(configuredUrl);
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
  const layer = layerProbeFailure(processProbeFailure, fetchFn);

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
  const layer = layerProbeFailure(processProbeFailure, fetchFn);

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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

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
    const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });
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
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
    const servers = yield* scanner.scan();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.url).toBe(`https://localhost:${LSOF_TEST_PORT}`);
    expect(redirects).toEqual(["manual", "manual"]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("probes a port only while T3 terminals own every listener on it", () => {
  const owned = `p1234\ncnode\nn[::1]:${LSOF_TEST_PORT}\n`;
  const unowned = `p5678\ncrpc\nn127.0.0.1:${LSOF_TEST_PORT}\n`;
  let stdout = unowned;
  const requests: string[] = [];
  const fetchFn = ((input: Parameters<typeof globalThis.fetch>[0]) => {
    requests.push(String(input));
    return Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } }));
  }) as typeof globalThis.fetch;
  const layer = layerLsofScanner({ pid: () => 1234, fetch: fetchFn, stdout: () => stdout });

  return Effect.gen(function* () {
    const scanner = yield* ownedScanner();
    expect(yield* scanner.scan()).toHaveLength(0);
    stdout = `${owned}${unowned}`;
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toEqual([]);

    stdout = owned;
    expect(yield* scanner.scan()).toHaveLength(1);
    expect(requests).toEqual([`http://localhost:${LSOF_TEST_PORT}/`]);

    yield* scanner.unregisterTerminal({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
    });
    expect(yield* scanner.scan()).toHaveLength(0);
    expect(requests).toHaveLength(1);
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
    const layer = layerLsofScanner({ pid: () => pid, fetch: fetchFn });

    return Effect.gen(function* () {
      const scanner = yield* ownedScanner([1, 2, 3, 4, 5, 6, 7]);
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

const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:223D 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5001 1 0000000000000000 100 0 0 10 0
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1 0000000000000000 100 0 0 10 0
   2: 0100007F:223D 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 5003 1 0000000000000000 20 4 30 10 -1
   3: 0A00000F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5005 1 0000000000000000 100 0 0 10 0
`;
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5004 1 0000000000000000 100 0 0 10 0
`;

effectIt.effect(
  "reads Linux listeners from /proc when lsof is missing, and stops spawning it",
  () => {
    let lsofSpawns = 0;
    const fdWalks: string[] = [];
    const procFiles: Record<string, string> = {
      "/proc/net/tcp": PROC_NET_TCP,
      "/proc/net/tcp6": PROC_NET_TCP6,
      "/proc/4242/comm": "python3\n",
    };
    const procFds: Record<string, Record<string, string>> = {
      "4242": { "0": "/dev/null", "3": "socket:[5001]" },
      "77": { "5": "socket:[9999]" },
    };
    const missing = FileSystem.makeNoop({});
    const fileSystem = FileSystem.layerNoop({
      readFileString: (path) => {
        const content = procFiles[path];
        return content === undefined ? missing.readFileString(path) : Effect.succeed(content);
      },
      readDirectory: (path) => {
        if (path === "/proc") return Effect.succeed(["self", "77", "4242"]);
        const pid = /^\/proc\/(\d+)\/fd$/.exec(path)?.[1];
        const fds = pid === undefined ? undefined : procFds[pid];
        if (pid === undefined || fds === undefined) return missing.readDirectory(path);
        fdWalks.push(pid);
        return Effect.succeed(Object.keys(fds));
      },
      readLink: (path) => {
        const [, pid, fd] = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path) ?? [];
        const target = pid && fd ? procFds[pid]?.[fd] : undefined;
        return target === undefined ? missing.readLink(path) : Effect.succeed(target);
      },
    });
    const fetchFn = (() =>
      Promise.resolve(
        new Response("hello", { headers: { "content-type": "text/html" } }),
      )) as typeof globalThis.fetch;
    const layer = layerProbeFailure(
      (input) => {
        lsofSpawns += 1;
        return processProbeFailure(input);
      },
      fetchFn,
      fileSystem,
    );

    return Effect.gen(function* () {
      const scanner = yield* ownedScanner([4242]);
      const first = yield* scanner.scan();
      expect(first.map(({ port, pid, processName }) => ({ port, pid, processName }))).toEqual([
        { port: 8765, pid: 4242, processName: "python3" },
      ]);
      yield* scanner.scan();
      expect(lsofSpawns).toBe(1);
      expect(fdWalks).toEqual(["77", "4242", "77", "4242"]);
      yield* scanner.scan();
      yield* scanner.scan();
      expect(fdWalks).toEqual(["77", "4242", "77", "4242", "77", "4242"]);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("ignores a partial Windows netstat snapshot when one query exits nonzero", () => {
  const fetchFn = (() =>
    Promise.resolve(
      new Response("hello", { headers: { "content-type": "text/html" } }),
    )) as typeof globalThis.fetch;
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProc,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            const isIpv6 = input.args.includes("tcpv6");
            return Effect.succeed({
              stdout: isIpv6
                ? ""
                : "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       1234\r\n",
              stderr: "",
              code: isIpv6 ? ChildProcessSpawner.ExitCode(1) : null,
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            });
          },
        }),
        Layer.succeed(HostProcess.Platform, "win32"),
        FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn))),
      ),
    ),
  );

  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    yield* scanner.registerTerminalProcesses({
      threadId: "scanner-thread",
      terminalId: "scanner-terminal",
      processIds: [1234],
    });
    expect(yield* scanner.scan()).toEqual([]);
  }).pipe(Effect.provide(layer));
});

const processOutput = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

effectIt.effect("rechecks the socket owner before stopping a Linux server without lsof", () => {
  let holder = "4242";
  const missing = FileSystem.makeNoop({});
  const layer = layerProbeFailure(
    (input) =>
      input.command === "lsof"
        ? processProbeFailure(input)
        : Effect.succeed(processOutput("4242 1 4300\n5000 1 5300\n")),
    () => Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } })),
    FileSystem.layerNoop({
      readFileString: (path) => {
        if (path === "/proc/net/tcp") {
          return Effect.succeed(PROC_NET_TCP.split("\n").slice(0, 2).join("\n"));
        }
        if (/^\/proc\/(4242|5000)\/comm$/.test(path)) return Effect.succeed("node\n");
        if (/^\/proc\/(4242|5000)\/environ$/.test(path)) {
          return Effect.succeed(`${PortScanner.AGENT_THREAD_ENV}=thread-agent\0`);
        }
        return missing.readFileString(path);
      },
      readDirectory: (path) => {
        if (path === "/proc") return Effect.succeed(["4242", "5000"]);
        if (/^\/proc\/(4242|5000)\/fd$/.test(path)) {
          return Effect.succeed(path === `/proc/${holder}/fd` ? ["3"] : []);
        }
        return missing.readDirectory(path);
      },
      readLink: (path) =>
        path === `/proc/${holder}/fd/3` ? Effect.succeed("socket:[5001]") : missing.readLink(path),
    }),
  );

  return Effect.gen(function* () {
    const signal = vi.spyOn(ProcessGroup, "signalProcessGroup").mockImplementation(() => {
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => signal.mockRestore()));
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toMatchObject([{ pid: 4242, port: 8765 }]);

    // The socket outlives its original holder. Its old pid now belongs to another agent job.
    holder = "5000";
    const result = yield* scanner
      .stopServer({ pid: 4242, port: 8765 })
      .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => null }));
    expect(signal).not.toHaveBeenCalled();
    expect(result).toBe("not-found");
    expect(yield* scanner.scan()).toMatchObject([{ pid: 5000, port: 8765 }]);
    yield* scanner.stopServer({ pid: 5000, port: 8765 });
    expect(signal).toHaveBeenCalledExactlyOnceWith(5300, "SIGTERM");
  }).pipe(Effect.provide(layer));
});

effectIt.effect.each(["linux", "darwin"] as const)(
  "attributes listeners to the agent thread in their environment on %s, after the agent exits",
  (platform) => {
    const agentPort = 43_124;
    const otherPort = 43_125;
    const agentListener = `p4242\ncnode\nn127.0.0.1:${agentPort}\n`;
    const otherListener = `p5000\ncpostgres\nn127.0.0.1:${otherPort}\n`;
    let lsofStdout = otherListener;
    let lsofFails = false;
    let environmentFails = false;
    let lsofCalls = 0;
    let environmentReads = 0;
    const requests: string[] = [];
    const missing = FileSystem.makeNoop({});
    const procEnviron: Record<string, string> = {
      "/proc/4242/environ": `PATH=/usr/bin\0${PortScanner.AGENT_THREAD_ENV}=thread-agent\0`,
      "/proc/5000/environ": "PATH=/usr/bin\0",
    };
    const layer = PortScanner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          FileSystem.layerNoop({
            readFileString: (path) => {
              const content = procEnviron[path];
              if (content === undefined) return missing.readFileString(path);
              environmentReads += 1;
              return Effect.succeed(content);
            },
          }),
          Layer.succeed(ProcessRunner.ProcessRunner, {
            run: (input) => {
              if (input.command === "lsof") {
                lsofCalls += 1;
                return lsofFails
                  ? Effect.fail(
                      new ProcessRunner.ProcessTimeoutError({
                        command: input.command,
                        argumentCount: input.args.length,
                        cwd: input.cwd,
                        timeoutMs: 5_000,
                      }),
                    )
                  : Effect.succeed(processOutput(lsofStdout));
              }
              // A direct child of this process, so stop refuses it without signaling anything.
              if (input.args[0] === "-A") {
                return Effect.succeed(processOutput(`4242 ${process.pid} 4242\n`));
              }
              if (environmentFails) {
                return Effect.fail(
                  new ProcessRunner.ProcessTimeoutError({
                    command: input.command,
                    argumentCount: input.args.length,
                    timeoutMs: 5_000,
                  }),
                );
              }
              environmentReads += 1;
              return Effect.succeed(
                processOutput(
                  `  4242 node server.js PATH=/usr/bin ${PortScanner.AGENT_THREAD_ENV}=thread-agent HOME=/Users/dev\n` +
                    "  5000 postgres -D /data PATH=/usr/bin\n",
                ),
              );
            },
          }),
          Layer.succeed(HostProcess.Platform, platform),
          FetchHttpClient.layer.pipe(
            Layer.provide(
              Layer.succeed(FetchHttpClient.Fetch, (input) => {
                requests.push(String(input));
                return Promise.resolve(
                  new Response("app", { headers: { "content-type": "text/html" } }),
                );
              }),
            ),
          ),
        ),
      ),
    );

    return Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      // Startup reads listeners once. With none marked, later scans stay idle.
      expect(yield* scanner.scan()).toEqual([]);
      expect(yield* scanner.scan()).toEqual([]);
      expect(lsofCalls).toBe(1);

      // The agent exits before any client looks, and the first read fails; its server is still
      // found.
      lsofStdout = `${agentListener}${otherListener}`;
      scanner.trackAgent()();
      lsofFails = true;
      expect(yield* scanner.scan()).toEqual([]);
      lsofFails = false;
      if (platform === "darwin") {
        environmentFails = true;
        expect(yield* scanner.scan()).toEqual([]);
        environmentFails = false;
      }
      expect(yield* scanner.scan()).toMatchObject([
        { port: agentPort, pid: 4242, terminal: null, agent: { threadId: "thread-agent" } },
      ]);
      expect(requests).toEqual([`http://localhost:${agentPort}/`]);

      expect(yield* scanner.scan()).toHaveLength(1);
      expect(environmentReads).toBe(2);

      // Stop reads its target's environment again rather than trust the cache, and still finds it.
      const stop = yield* Effect.flip(scanner.stopServer({ pid: 4242, port: agentPort }));
      expect(stop.reason).toBe("shared-group");
      expect(environmentReads).toBe(3);

      lsofStdout = otherListener;
      expect(yield* scanner.scan()).toEqual([]);
      const lsofCallsAfterExit = lsofCalls;
      expect(yield* scanner.scan()).toEqual([]);
      expect(lsofCalls).toBe(lsofCallsAfterExit);
    }).pipe(Effect.provide(layer));
  },
);

effectIt.effect("finds a server an agent left before a restart on the first scan", () => {
  const port = 43_127;
  let lsofStdout = `p4242\ncnode\nn127.0.0.1:${port}\n`;
  let lsofCalls = 0;
  const missing = FileSystem.makeNoop({});
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          readFileString: (path) =>
            path === "/proc/4242/environ"
              ? Effect.succeed(`${PortScanner.AGENT_THREAD_ENV}=thread-agent\0`)
              : missing.readFileString(path),
        }),
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () => {
            lsofCalls += 1;
            return Effect.succeed(processOutput(lsofStdout));
          },
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, () =>
              Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } })),
            ),
          ),
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    // No agent has run and no terminal is open since this server started.
    expect(yield* scanner.scan()).toMatchObject([
      { port, pid: 4242, terminal: null, agent: { threadId: "thread-agent" } },
    ]);
    lsofStdout = "";
    expect(yield* scanner.scan()).toEqual([]);
    const lsofCallsAfterExit = lsofCalls;
    expect(yield* scanner.scan()).toEqual([]);
    expect(lsofCalls).toBe(lsofCallsAfterExit);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("never reads listeners on Windows while idle, including the startup read", () => {
  let processCalls = 0;
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerNoProc,
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) => {
            processCalls += 1;
            return processProbeFailure(input);
          },
        }),
        Layer.succeed(HostProcess.Platform, "win32"),
        FetchHttpClient.layer,
      ),
    ),
  );
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    expect(yield* scanner.scan()).toEqual([]);
    expect(yield* scanner.scan()).toEqual([]);
    expect(processCalls).toBe(0);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("forgets agent pids while no client scans, since they can be reused", () => {
  const port = 43_126;
  let environ = `${PortScanner.AGENT_THREAD_ENV}=thread-agent\0`;
  const missing = FileSystem.makeNoop({});
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          readFileString: (path) =>
            path === "/proc/4242/environ" ? Effect.succeed(environ) : missing.readFileString(path),
        }),
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: () => Effect.succeed(processOutput(`p4242\ncnode\nn127.0.0.1:${port}\n`)),
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, () =>
              Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } })),
            ),
          ),
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    const scanner = yield* PortScanner.PortDiscovery;
    scanner.trackAgent()();
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* scanner.retain;
        expect(yield* scanner.scan()).toMatchObject([
          { pid: 4242, agent: { threadId: "thread-agent" } },
        ]);
      }),
    );
    // While nobody scanned, the server exited and an unrelated listener got its pid.
    environ = "PATH=/usr/bin\0";
    expect(yield* scanner.scan()).toEqual([]);
  }).pipe(Effect.provide(layer));
});

effectIt.effect("stops only a job's own process group", () =>
  Effect.sync(() => {
    const serverPid = 100;
    const rows = [
      { pid: 10, ppid: 1, pgid: 10 }, // `vp run dev`, whose job holds this server
      { pid: 20, ppid: 10, pgid: 10 }, // the web dev server in the same job
      { pid: serverPid, ppid: 10, pgid: 10 },
      { pid: 200, ppid: serverPid, pgid: 200 }, // agent CLI
      { pid: 210, ppid: 200, pgid: 200 }, // a server it spawned without a group of its own
      { pid: 300, ppid: 200, pgid: 300 }, // agent tool shell
      { pid: 400, ppid: 300, pgid: 400 }, // `npm run dev &`
      { pid: 401, ppid: 400, pgid: 400 },
      { pid: 500, ppid: serverPid, pgid: 500 }, // terminal shell
      { pid: 600, ppid: 500, pgid: 600 }, // terminal job
    ];
    const table = new Map(rows.map((row) => [row.pid, row]));
    expect(PortScanner.stoppableProcessGroup(table, 401, serverPid)).toBe(400);
    expect(PortScanner.stoppableProcessGroup(table, 600, serverPid)).toBe(600);
    for (const pid of [20, 210, 500, 999]) {
      expect(PortScanner.stoppableProcessGroup(table, pid, serverPid)).toBeNull();
    }
  }),
);

effectIt.effect.each([
  // The server exits on SIGTERM, and a child that ignores it stays in the job's group.
  {
    name: "sends SIGKILL after the grace period to a child that ignores SIGTERM",
    afterTerm: "4301 1 4300\n",
    killed: true,
  },
  // Only the job's original members count, so a group id reused since is never killed.
  {
    name: "never sends SIGKILL to an unrelated process that reused the group",
    afterTerm: "5000 1 4300\n",
    killed: false,
  },
])("$name", ({ afterTerm, killed }) => {
  const port = 43_128;
  let table = "4300 1 4300\n4242 4300 4300\n4301 4242 4300\n";
  const signals: Array<readonly [number, NodeJS.Signals | 0]> = [];
  const missing = FileSystem.makeNoop({});
  const layer = PortScanner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          readFileString: (path) =>
            path === "/proc/4242/environ"
              ? Effect.succeed(`${PortScanner.AGENT_THREAD_ENV}=thread-agent\0`)
              : missing.readFileString(path),
        }),
        Layer.succeed(ProcessRunner.ProcessRunner, {
          run: (input) =>
            Effect.succeed(
              processOutput(
                input.command === "lsof" ? `p4242\ncnode\nn127.0.0.1:${port}\n` : table,
              ),
            ),
        }),
        Layer.succeed(HostProcess.Platform, "linux"),
        FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, () =>
              Promise.resolve(new Response("app", { headers: { "content-type": "text/html" } })),
            ),
          ),
        ),
      ),
    ),
  );
  return Effect.gen(function* () {
    const signal = vi
      .spyOn(ProcessGroup, "signalProcessGroup")
      .mockImplementation((group, name) => {
        signals.push([group, name]);
        if (name === "SIGTERM") table = afterTerm;
      });
    yield* Effect.addFinalizer(() => Effect.sync(() => signal.mockRestore()));
    const scanner = yield* PortScanner.PortDiscovery;
    const stop = yield* Effect.forkChild(scanner.stopServer({ pid: 4242, port }));
    yield* TestClock.adjust(Duration.seconds(2));
    expect(signals).toEqual([[4300, "SIGTERM"]]);
    yield* TestClock.adjust(Duration.seconds(2));
    yield* Fiber.join(stop);
    expect(signals).toEqual(
      killed
        ? [
            [4300, "SIGTERM"],
            [4300, "SIGKILL"],
          ]
        : [[4300, "SIGTERM"]],
    );
  }).pipe(Effect.provide(layer));
});

const AGENT_SERVER_SCRIPT = `
const server = require("node:http").createServer((_, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<html></html>");
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(process.pid + " " + server.address().port + "\\n");
});
`;

/**
 * A real HTML server with an agent's environment. As a job it runs the way an agent's tool shell
 * starts one: under a detached shell with job control, in a group of its own. Otherwise it runs
 * directly under this process, in its group. Release kills only the pids it started.
 */
const agentServer = (options: { readonly job: boolean }) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly child: NodeChildProcess.ChildProcess;
      readonly pid: number;
      readonly port: number;
      readonly exited: Promise<void>;
    }>((resume) => {
      const env = { ...process.env, [PortScanner.AGENT_THREAD_ENV]: "thread-live" };
      const child = options.job
        ? // dash ignores `set -m` without a terminal; bash, like agent tool shells, honors it.
          NodeChildProcess.spawn(
            "bash",
            ["-c", 'set -m; "$0" -e "$1" & wait', process.execPath, AGENT_SERVER_SCRIPT],
            { detached: true, env, stdio: ["ignore", "pipe", "ignore"] },
          )
        : NodeChildProcess.spawn(process.execPath, ["-e", AGENT_SERVER_SCRIPT], {
            env,
            stdio: ["ignore", "pipe", "ignore"],
          });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.once("error", (error) => resume(Effect.die(error)));
      child.stdout?.once("data", (chunk) => {
        const [pid, port] = String(chunk).trim().split(" ").map(Number);
        resume(Effect.succeed({ child, pid: pid!, port: port!, exited }));
      });
    }),
    ({ child, pid }) =>
      Effect.sync(() => {
        for (const target of [pid, child.pid]) {
          try {
            if (target !== undefined) process.kill(target, "SIGKILL");
          } catch {}
        }
      }),
  );

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

effectIt.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "stops an agent's server through its job's group and refuses a group shared with this server",
  () =>
    Effect.gen(function* () {
      const scanner = yield* PortScanner.PortDiscovery;
      yield* Effect.acquireRelease(Effect.sync(scanner.trackAgent), (release) =>
        Effect.sync(release),
      );
      const job = yield* agentServer({ job: true });
      const shared = yield* agentServer({ job: false });

      expect(yield* scanner.scan()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pid: job.pid,
            port: job.port,
            agent: { threadId: "thread-live" },
          }),
          expect.objectContaining({
            pid: shared.pid,
            port: shared.port,
            agent: { threadId: "thread-live" },
          }),
        ]),
      );

      const unlisted = yield* Effect.flip(scanner.stopServer({ pid: process.pid, port: job.port }));
      expect(unlisted.reason).toBe("not-found");
      const refused = yield* Effect.flip(
        scanner.stopServer({ pid: shared.pid, port: shared.port }),
      );
      expect(refused.reason).toBe("shared-group");
      expect(isRunning(shared.pid)).toBe(true);

      yield* scanner.stopServer({ pid: job.pid, port: job.port });
      // The shell waits on its job, so it exits once the job has.
      yield* Effect.promise(() => job.exited);
      expect(isRunning(job.pid)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        PortScanner.layer.pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
        ),
      ),
    ),
);
