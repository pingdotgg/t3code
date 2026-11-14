import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  ensureTailscaleServe,
  parseTailscaleExitNode,
  parseTailscaleServeRootHolders,
  parseTailscaleServeRoutesTo,
  parseTailscaleSshEnabled,
  parseTailscaleStatus,
  probeTailscaleHttpsEndpoint,
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

// The executable name depends on the host platform (`tailscale.exe` on
// Windows), so pin it: these tests assert the posix spelling.
function layerSpawner(spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) {
  return Layer.merge(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(HostProcess.Platform, "linux"),
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
  it.effect("does not treat a non-T3 response on the HTTPS probe path as reachable", () =>
    Effect.gen(function* () {
      for (const [body, status] of [
        ["<!doctype html><title>Other application</title>", 200],
        [null, 204],
      ] as const) {
        const reachable = yield* probeTailscaleHttpsEndpoint({
          baseUrl: "https://desktop.example.ts.net",
          environmentId: "this-environment",
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
            ),
          ),
        );
        assert.isFalse(reachable, `HTTP ${status} without a T3 descriptor`);
      }
    }),
  );

  it.effect("does not treat another T3 server behind the Serve URL as this server", () =>
    Effect.gen(function* () {
      const answer = (environmentId: string) =>
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                environmentId,
                label: "T3 server",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.1.9",
                capabilities: { repositoryIdentity: true },
              }),
            ),
          ),
        );
      const probe = (served: string) =>
        probeTailscaleHttpsEndpoint({
          baseUrl: "https://desktop.example.ts.net",
          environmentId: "this-environment",
        }).pipe(Effect.provideService(HttpClient.HttpClient, answer(served)));

      assert.isTrue(yield* probe("this-environment"));
      assert.isFalse(yield* probe("another-environment"));
    }),
  );

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

  it("finds what holds a Serve port's root", () => {
    const target = { host: "127.0.0.1", port: 3773 };
    const status = JSON.stringify({
      TCP: { "8443": { TCPForward: "127.0.0.1:22" } },
      Web: {
        "box.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3773" }, "/x": { Proxy: "9000" } },
        },
        "old.tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://[::1]:4000" } } },
        "box.tailnet.ts.net:10000": { Handlers: { "/": { Proxy: "http://127.0.0.1:4001" } } },
        "box.tailnet.ts.net:10001": { Handlers: { "/": { Proxy: "http://10.0.0.5:4002" } } },
        "box.tailnet.ts.net:10002": { Handlers: { "/": { Text: "hi" } } },
      },
      Services: {
        "svc:t3": {
          Web: { "t3.tailnet.ts.net:10000": { Handlers: { "/": { Proxy: "4003" } } } },
        },
      },
    });
    assert.deepEqual(parseTailscaleServeRootHolders(status, 443, target), [
      { ours: true },
      { ours: false, loopback: { host: "::1", port: 4000 } },
    ]);
    assert.deepEqual(parseTailscaleServeRootHolders(status, 10000, target), [
      { ours: false, loopback: { host: "127.0.0.1", port: 4001 } },
    ]);
    assert.deepEqual(parseTailscaleServeRootHolders(status, 10001, target), [{ ours: false }]);
    assert.deepEqual(parseTailscaleServeRootHolders(status, 10002, target), [{ ours: false }]);
    assert.deepEqual(parseTailscaleServeRootHolders(status, 8443, target), [{ ours: false }]);
    assert.deepEqual(parseTailscaleServeRootHolders("null", 443, target), []);
    assert.isUndefined(parseTailscaleServeRootHolders("not json", 443, target));
  });

  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        running: null,
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

  // regression: #34736 - a full stdout pipe blocks the child before it exits.
  it.effect("drains serve stdout so a long success summary does not time out", () =>
    Effect.gen(function* () {
      const stdoutDrained = yield* Deferred.make<void>();
      const layer = layerSpawner(
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Deferred.await(stdoutDrained).pipe(
                Effect.as(ChildProcessSpawner.ExitCode(0)),
              ),
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(encoder.encode("https://example.ts.net/\n")).pipe(
                Stream.ensuring(Deferred.succeed(stdoutDrained, undefined)),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          ),
        ),
      );

      const fiber = yield* ensureTailscaleServe({ localPort: 3773 }).pipe(
        Effect.provide(layer),
        Effect.exit,
        Effect.forkChild,
      );
      yield* TestClock.adjust("11 seconds");
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isSuccess(exit), String(exit));
    }),
  );

  // regression: #35510 - without the https capability `tailscale serve` prints an
  // enablement notice, writes no Serve config, and still exits 0.
  it.effect("fails serve when the tailnet has not enabled HTTPS", () => {
    const layer = layerMockSpawner((_command, args) => {
      if (args[0] === "status") {
        return {
          stdout:
            '{"BackendState":"Running","Self":{"DNSName":"desktop.tail.ts.net.","CapMap":{}}}',
        };
      }
      if (args[1] === "status") return { stdout: "{}\n" };
      return { stdout: "\nYou don't have permission to enable this feature.\n" };
    });

    return Effect.gen(function* () {
      const exit = yield* ensureTailscaleServe({ localPort: 3773 }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit), "no Serve route was configured");
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
      assert.deepEqual(killGraces, [500, 500, 500, 500]);
    });
  });
});
