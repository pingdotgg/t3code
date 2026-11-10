import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import {
  findTailscaleExecutable,
  isServeTargetFor,
  isTailnetAddress,
  readTailnet,
  parseTailscaleWhois,
  selectTailscaleServePort,
  tailscaleServePortCandidates,
  whoisTailnetAddress,
  parseTailscaleServeHandlers,
  ensureTailscaleServe,
  parseTailscaleExitNode,
  parseTailscaleServeRoutesTo,
  parseTailscaleSshEnabled,
  parseTailscaleStatus,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

function assertCarriesNoSecret(error: object, secret: string): void {
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      assert.notInclude(value, secret, `${path} leaked stderr`);
      return;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${String(index)}]`));
      return;
    }
    // `message` and `cause` are getters on Error subclasses, so they are not
    // own enumerable properties and Object.entries alone would skip them.
    walk((value as { message?: unknown }).message, `${path}.message`);
    walk((value as { cause?: unknown }).cause, `${path}.cause`);
    for (const [key, nested] of Object.entries(value)) {
      walk(nested, `${path}.${key}`);
    }
  };

  walk(error, "error");
}
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

// The executable depends on the host platform (`tailscale.exe` on Windows) and
// on what is installed, so pin both: these tests assert the bare posix name.
function layerSpawner(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(SpawnExecutableResolution, () => undefined),
  );
}

function layerMockSpawner(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return layerSpawner(
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

describe("tailscale", () => {
  it("finds the Serve routes that forward to the bound address, and only those", () => {
    const status = JSON.stringify({
      TCP: {
        "443": { HTTPS: true },
        "7000": { TCPForward: "127.0.0.1:3773" },
        "7001": { TCPForward: "127.0.0.2:3773" },
        "80": { TCPForward: "unix:/run/app.sock" },
      },
      Web: {
        "box.tailnet.ts.net:443": {
          Handlers: {
            "/t3": { Proxy: "http://127.0.0.1:3773" },
            "/dashboard": { Proxy: "http://127.0.0.1:9000" },
          },
        },
        "box.tailnet.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5173" } } },
        "box.tailnet.ts.net:10000": {
          Handlers: {
            // Another service on another loopback address, and one on the other family.
            "/a": { Proxy: "http://127.0.0.2:3773" },
            "/b": { Proxy: "http://[::1]:3773" },
            "/c": { Proxy: "http://192.168.1.5:3773" },
            "/d": { Proxy: "http://0.0.0.0:3773" },
            "/e": { Proxy: "http://[::ffff:127.0.0.1]:3773" },
            "/f": { Proxy: "http://localhost:3773" },
            // Shorthand Tailscale expands when it proxies.
            "/g": { Proxy: "3773" },
            "/h": { Proxy: "localhost:3773" },
            "/i": { Proxy: "http://[::]:3773" },
            // A name can resolve to any address, the bound one included.
            "/j": { Proxy: "http://ip6-localhost:3773" },
            // Go resolves these as names; a WHATWG URL rejects the first and rewrites the second.
            "/k": { Proxy: "http://box.1:3773" },
            "/l": { Proxy: "http://127.1:3773" },
            "/m": { Proxy: "unix:/run/app.sock" },
            // Credentials before the host, and IPv6 written out in full, still dial here.
            "/n": { Proxy: "http://user:pass@127.0.0.1:3773" },
            "/o": { Proxy: "http://[0:0:0:0:0:ffff:7f00:1]:3773" },
            "/p": { Proxy: "http://127.0.0.1:03773" },
          },
        },
      },
      Services: {
        "svc:t3": {
          Web: {
            "t3.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } } },
          },
        },
      },
      Foreground: {
        session1: { TCP: { "9000": { TCPForward: "localhost:3773" } } },
      },
    });
    assert.deepEqual(parseTailscaleServeRoutesTo(status, { host: "127.0.0.1", port: 3773 }), [
      { servePort: 7000 },
      { servePort: 443, mount: "/t3", host: "box.tailnet.ts.net" },
      // `localhost` and `[::]` can dial either loopback, so they might be another service's.
      ...(
        [
          ["/d", undefined],
          ["/e", undefined],
          ["/f", "localhost"],
          ["/g", undefined],
          ["/h", "localhost"],
          ["/i", "[::]"],
          ["/j", "ip6-localhost"],
          ["/k", "box.1"],
          ["/l", "127.1"],
          ["/n", undefined],
          ["/o", undefined],
          ["/p", undefined],
        ] as const
      ).map(([mount, ambiguous]) => ({
        servePort: 10000,
        mount,
        host: "box.tailnet.ts.net",
        ...(ambiguous === undefined ? {} : { ambiguous }),
      })),
      { servePort: 443, mount: "/", host: "t3.tailnet.ts.net", owner: "svc:t3" },
      { servePort: 9000, ambiguous: "localhost", owner: "foreground" },
    ]);
    assert.deepEqual(
      parseTailscaleServeRoutesTo(
        JSON.stringify({
          Web: { "box:443": { Handlers: { "/": { Proxy: "http://127.0.0.1" } } } },
        }),
        { host: "127.0.0.1", port: 80 },
      ),
      [{ servePort: 443, mount: "/", host: "box" }],
    );
    assert.deepEqual(parseTailscaleServeRoutesTo("{}", { host: "127.0.0.1", port: 3773 }), []);
    assert.deepEqual(parseTailscaleServeRoutesTo("null", { host: "127.0.0.1", port: 3773 }), []);
    assert.isUndefined(parseTailscaleServeRoutesTo("not json", { host: "127.0.0.1", port: 3773 }));
  });

  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
        httpsServeEnabled: null,
      });
    }),
  );

  it.effect("names the exit node in use", () =>
    Effect.gen(function* () {
      const inUse = yield* parseTailscaleExitNode(
        JSON.stringify({
          ExitNodeStatus: { ID: "nX", Online: true, TailscaleIPs: ["100.101.102.103/32"] },
          Peer: {
            "nodekey:a": { HostName: "laptop", DNSName: "laptop.tail.ts.net.", ExitNode: false },
            "nodekey:b": {
              HostName: "raspberrypi",
              DNSName: "home-pi.tail.ts.net.",
              ExitNode: true,
            },
          },
        }),
      );
      assert.deepEqual(inUse, { name: "home-pi", online: true });

      const unnamed = yield* parseTailscaleExitNode(`{"ExitNodeStatus":{"Online":false}}`);
      assert.deepEqual(unnamed, { name: null, online: false });

      assert.equal(yield* parseTailscaleExitNode(tailscaleStatusJson), null);
    }),
  );

  it.effect("reads the HTTPS serve capability from the status capability map", () =>
    Effect.gen(function* () {
      const enabled = yield* parseTailscaleStatus(
        `{"Self":{"CapMap":{"https":null,"funnel":null}}}`,
      );
      assert.equal(enabled.httpsServeEnabled, true);

      const disabled = yield* parseTailscaleStatus(`{"Self":{"CapMap":{"funnel":null}}}`);
      assert.equal(disabled.httpsServeEnabled, false);
    }),
  );

  it.effect("reads Tailscale SSH enablement from local prefs", () => {
    const prefsJson =
      '{\n\t"ControlURL": "https://controlplane.tailscale.com",\n\t"RunSSH": true,\n\t"WantRunning": true\n}\n';
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["debug", "prefs"]);
      return { stdout: prefsJson };
    });

    return Effect.gen(function* () {
      assert.isTrue(yield* readTailscaleSshEnabled.pipe(Effect.provide(layer)));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":false,"WantRunning":true}'));
      assert.isFalse(yield* parseTailscaleSshEnabled('{"RunSSH":true,"WantRunning":false}'));
      assert.isFalse(yield* parseTailscaleSshEnabled("{}"));
      const error = yield* parseTailscaleSshEnabled("{not-json").pipe(Effect.flip);
      assert.instanceOf(error, TailscaleStatusParseError);
    });
  });

  it.effect("turns spawn defects into typed spawn failures", () => {
    // A non-directory entry on PATH makes node's spawn throw ENOTDIR
    // synchronously. The platform spawner calls `NodeChildProcess.spawn` from
    // inside an `Effect.callback` registration, so that throw arrives as a
    // defect rather than a typed error - the shape reproduced here.
    const defect = Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" });
    const layer = layerSpawner(
      ChildProcessSpawner.make(() =>
        Effect.callback<never, never>(() => {
          throw defect;
        }),
      ),
    );

    return Effect.gen(function* () {
      const statusError = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(statusError, TailscaleCommandSpawnError);
      assert.equal(statusError.subcommand, "status");
      assert.strictEqual(statusError.cause, defect);

      const serveError = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(serveError, TailscaleCommandSpawnError);
      assert.equal(serveError.subcommand, "serve");
      assert.strictEqual(serveError.cause, defect);

      const degraded = yield* readTailscaleStatus.pipe(
        Effect.orElseSucceed(() => null),
        Effect.provide(layer),
      );
      assert.equal(degraded, null);
    });
  });

  it.effect("keeps nonzero exit diagnostics structured", () => {
    const layer = layerMockSpawner(() => ({
      code: 7,
      stderr: "not logged in tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdoutLength, 0);
      assert.equal(error.stderrLength, 43);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      assert.equal(error.message, "tailscale status exited with code 7.");
      assert.equal(error.stderrDiagnostic, "not-logged-in");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  // regression: #21609 - without forceKillAfter a timed-out probe only gets
  // SIGTERM, so a group member that ignores it outlives the call.
  it.effect("escalates timed-out probes to SIGKILL", () => {
    const killGraces: Array<number | undefined> = [];
    const layer = layerSpawner(
      ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") {
          const { forceKillAfter } = command.options;
          killGraces.push(
            forceKillAfter === undefined
              ? undefined
              : Duration.toMillis(Duration.fromInputUnsafe(forceKillAfter)),
          );
        }
        return Effect.succeed(mockHandle({ stdout: "{}" }));
      }),
    );

    return Effect.gen(function* () {
      yield* readTailscaleStatus.pipe(Effect.provide(layer));
      yield* readTailscaleSshEnabled.pipe(Effect.provide(layer));
      yield* ensureTailscaleServe({ localPort: 45_678 }).pipe(Effect.provide(layer));
      assert.deepEqual(killGraces, [500, 500, 500]);
    });
  });
});

describe("tailscale serve ownership", () => {
  it.effect("reads each port's target from serve status", () =>
    Effect.gen(function* () {
      const handlers = yield* parseTailscaleServeHandlers(
        JSON.stringify({
          TCP: {
            "443": { HTTPS: true },
            "5555": { HTTPS: true },
            "2222": { TCPForward: "127.0.0.1:22" },
          },
          Web: {
            "host.example.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:4077" } } },
            "host.example.ts.net:5555": {
              Handlers: { "/api": { Proxy: "http://127.0.0.1:5555" } },
            },
          },
        }),
      );
      assert.deepEqual(handlers, [
        { servePort: 443, target: "http://127.0.0.1:4077" },
        { servePort: 5555, target: "http://127.0.0.1:5555" },
        { servePort: 2222, target: "tcp://127.0.0.1:22" },
      ]);
      assert.deepEqual(yield* parseTailscaleServeHandlers("{}"), []);
    }),
  );

  it("matches a target by port across loopback aliases only", () => {
    assert.isTrue(
      isServeTargetFor("http://localhost:5788", { localPort: 5788, localHost: "localhost" }),
    );
    assert.isTrue(
      isServeTargetFor("http://127.0.0.1:3773", { localPort: 3773, localHost: "[::1]" }),
    );
    assert.isFalse(isServeTargetFor("http://127.0.0.1:4077", { localPort: 3773 }));
    assert.isFalse(isServeTargetFor("tcp://127.0.0.1:3773", { localPort: 3773 }));
  });
});

describe("tailscale executable lookup", () => {
  const resolverFor =
    (installed: ReadonlyArray<string>, onPath: Record<string, string> = {}) =>
    (command: string) =>
      onPath[command] ?? (installed.includes(command) ? command : undefined);

  it("prefers PATH, then the platform's install locations", () => {
    const appBinary = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    const darwin = (resolve: ReturnType<typeof resolverFor>) =>
      findTailscaleExecutable({ platform: "darwin", env: {}, resolve });
    assert.equal(
      darwin(resolverFor([appBinary], { tailscale: "/opt/homebrew/bin/tailscale" })),
      "/opt/homebrew/bin/tailscale",
    );
    assert.equal(darwin(resolverFor([appBinary, "/usr/local/bin/tailscale"])), appBinary);
    assert.equal(
      darwin(resolverFor(["/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"])),
      "/opt/homebrew/bin/tailscale",
    );
    assert.equal(darwin(resolverFor(["/usr/local/bin/tailscale"])), "/usr/local/bin/tailscale");
    assert.equal(darwin(resolverFor([])), "tailscale");

    assert.equal(
      findTailscaleExecutable({
        platform: "win32",
        env: { ProgramFiles: "D:\\Apps" },
        resolve: resolverFor(["D:\\Apps\\Tailscale\\tailscale.exe"]),
      }),
      "D:\\Apps\\Tailscale\\tailscale.exe",
    );
    assert.equal(
      findTailscaleExecutable({ platform: "linux", env: {}, resolve: resolverFor([appBinary]) }),
      "tailscale",
    );
  });

  it.effect("spawns the resolved path", () => {
    const spawned: Array<string> = [];
    const layer = Layer.mergeAll(
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          spawned.push((command as unknown as { readonly command: string }).command);
          return Effect.succeed(mockHandle({ stdout: "{}" }));
        }),
      ),
      Layer.succeed(HostProcess.Platform, "darwin"),
      Layer.succeed(SpawnExecutableResolution, (command: string) =>
        command.startsWith("/Applications/") ? command : undefined,
      ),
    );
    return Effect.gen(function* () {
      yield* readTailscaleStatus.pipe(Effect.provide(layer));
      assert.deepEqual(spawned, ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"]);
    });
  });
});

// Trimmed from real `tailscale status --json` and `tailscale whois --json` output.
const tailnetStatusJson = JSON.stringify({
  BackendState: "Running",
  Self: {
    HostName: "MacBook Pro (3)",
    DNSName: "macbook.prawn-penny.ts.net.",
    TailscaleIPs: ["100.111.125.20", "fd7a:115c:a1e0::8401:a43c"],
    UserID: 431931774855047,
    Tags: null,
    OS: "macOS",
    CapMap: { "default-auto-update": [true], funnel: null, https: null },
  },
  Peer: {
    "nodekey:aa": {
      HostName: "dgx-01",
      DNSName: "dgx-01.prawn-penny.ts.net.",
      TailscaleIPs: ["100.111.125.200", "fd7a:115c:a1e0::a532:9c2b"],
      UserID: 431931774855047,
      Online: true,
      OS: "linux",
    },
    "nodekey:bb": {
      HostName: "localhost",
      DNSName: "t3-box.prawn-penny.ts.net.",
      TailscaleIPs: ["100.90.1.2"],
      UserID: 1234,
      Tags: ["tag:server"],
      Online: false,
      OS: "linux",
    },
    "nodekey:cc": { HostName: "phone", DNSName: "", TailscaleIPs: [], UserID: 431931774855047 },
  },
});

const whoisJson = JSON.stringify({
  Node: {
    ID: 296504211427553,
    Name: "studio-01.prawn-penny.ts.net.",
    User: 431931774855047,
    Addresses: ["100.104.231.93/32", "fd7a:115c:a1e0::5932:e75f/128"],
  },
  UserProfile: {
    ID: 431931774855047,
    LoginName: "jayleaton@gmail.com",
    DisplayName: "JJ Eaton",
  },
  CapMap: {},
});

describe("tailnet", () => {
  it.effect("reads this node and every peer", () =>
    Effect.gen(function* () {
      const tailnet = yield* readTailnet.pipe(
        Effect.provide(layerMockSpawner(() => ({ stdout: tailnetStatusJson }))),
      );
      assert.deepEqual(tailnet.self, {
        userId: "431931774855047",
        magicDnsName: "macbook.prawn-penny.ts.net",
        tailnetAddresses: ["100.111.125.20", "fd7a:115c:a1e0::8401:a43c"],
        httpsServeEnabled: true,
      });
      assert.deepEqual(tailnet.peers, [
        {
          nodeName: "dgx-01",
          magicDnsName: "dgx-01.prawn-penny.ts.net",
          tailnetAddresses: ["100.111.125.200", "fd7a:115c:a1e0::a532:9c2b"],
          userId: "431931774855047",
          tags: [],
          online: true,
          os: "linux",
        },
        {
          nodeName: "t3-box",
          magicDnsName: "t3-box.prawn-penny.ts.net",
          tailnetAddresses: ["100.90.1.2"],
          userId: "1234",
          tags: ["tag:server"],
          online: false,
          os: "linux",
        },
        {
          nodeName: "phone",
          magicDnsName: null,
          tailnetAddresses: [],
          userId: "431931774855047",
          tags: [],
          online: false,
          os: null,
        },
      ]);
    }),
  );

  it("recognizes only tailnet addresses", () => {
    assert.isTrue(isTailnetAddress("100.64.0.1"));
    assert.isTrue(isTailnetAddress("100.127.255.254"));
    assert.isTrue(isTailnetAddress("fd7a:115c:a1e0::5932:e75f"));
    assert.isTrue(isTailnetAddress("FD7A:115C:A1E0:ab12::1"));
    assert.isFalse(isTailnetAddress("100.128.0.1"));
    assert.isFalse(isTailnetAddress("192.168.1.10"));
    assert.isFalse(isTailnetAddress("fd7a:115c:a1e1::1"));
    assert.isFalse(isTailnetAddress("studio-01"));
  });

  it.effect("reads who owns a tailnet address", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* parseTailscaleWhois(whoisJson), {
        userId: "431931774855047",
        loginName: "jayleaton@gmail.com",
        nodeName: "studio-01",
        tags: [],
        capabilities: [],
      });
      const tagged = yield* parseTailscaleWhois(
        JSON.stringify({
          Node: { Name: "ci.prawn-penny.ts.net.", Tags: ["tag:ci"] },
          UserProfile: { ID: 99, LoginName: "tagged-devices" },
          CapMap: { "t3.codes/device": [{}] },
        }),
      );
      assert.deepEqual(tagged?.tags, ["tag:ci"]);
      assert.deepEqual(tagged?.capabilities, ["t3.codes/device"]);
    }),
  );

  it.effect("answers null for addresses outside the tailnet or unknown to it", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const layer = layerMockSpawner((_command, args) => {
      calls.push(args);
      return args.includes("100.64.0.1")
        ? { code: 1, stderr: "2026/10/30 16:47:06 peer not found" }
        : { stdout: whoisJson };
    });
    return Effect.gen(function* () {
      assert.isNull(yield* whoisTailnetAddress("192.168.1.10"));
      assert.isNull(yield* whoisTailnetAddress("studio-01"));
      assert.isNull(yield* whoisTailnetAddress("100.64.0.1"));
      assert.equal((yield* whoisTailnetAddress("100.104.231.93"))?.nodeName, "studio-01");
      assert.deepEqual(calls, [
        ["whois", "--json", "100.64.0.1"],
        ["whois", "--json", "100.104.231.93"],
      ]);
    }).pipe(Effect.provide(layer));
  });
});

describe("tailscale serve port selection", () => {
  const serveStatus = (targets: Record<number, string>) =>
    JSON.stringify({
      Web: Object.fromEntries(
        Object.entries(targets).map(([port, target]) => [
          `host.example.ts.net:${port}`,
          { Handlers: { "/": { Proxy: target } } },
        ]),
      ),
    });
  // Every target answers except the dead one on port 9.
  const layerFor = (targets: Record<number, string>) =>
    Layer.merge(
      layerMockSpawner(() => ({ stdout: serveStatus(targets) })),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          new URL(request.url).port === "9"
            ? Effect.fail(
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.TransportError({ request }),
                }),
              )
            : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
        ),
      ),
    );

  it("tries the preferred port, 443, 8443, then 3443 upward", () => {
    const first = (preferred: ReadonlyArray<number>, count: number) => {
      const ports: Array<number> = [];
      for (const port of tailscaleServePortCandidates(preferred)) {
        ports.push(port);
        if (ports.length === count) break;
      }
      return ports;
    };
    assert.deepEqual(first([], 4), [443, 8443, 3443, 3444]);
    assert.deepEqual(first([3445], 5), [3445, 443, 8443, 3443, 3444]);
    assert.deepEqual(first([8443], 3), [8443, 443, 3443]);
  });

  it.effect("skips ports serving another live server", () =>
    Effect.gen(function* () {
      const local = { localPort: 3773 };
      const pick = (targets: Record<number, string>, preferredPorts: ReadonlyArray<number> = []) =>
        selectTailscaleServePort({ ...local, preferredPorts }).pipe(
          Effect.map(({ servePort, ownership }) => [servePort, ownership._tag]),
          Effect.provide(layerFor(targets)),
        );
      assert.deepEqual(yield* pick({}), [443, "free"]);
      assert.deepEqual(
        yield* pick({ 443: "http://127.0.0.1:4077", 8443: "http://127.0.0.1:5000" }),
        [3443, "free"],
      );
      assert.deepEqual(
        yield* pick({ 443: "http://127.0.0.1:4077", 3445: "http://127.0.0.1:3773" }, [3445]),
        [3445, "ours"],
      );
      assert.deepEqual(yield* pick({ 443: "http://127.0.0.1:9" }), [443, "stale"]);
    }),
  );
});
