import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  parseTailscaleStatus,
  readTailscaleStatus,
  TAILSCALE_STATUS_TIMEOUT,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleCommandTimeoutError,
  TailscaleStatusParseError,
  TailscaleServePortOccupiedError,
  TailscaleServeStatusParseError,
} from "./tailscale.ts";

const encoder = new TextEncoder();

/**
 * Asserts nothing reachable from `error` contains `secret`. Recurses through
 * nested objects, arrays, and `cause` chains rather than checking only
 * top-level strings: a leak one level down (say, a wrapped cause carrying raw
 * stderr) is just as visible in a log, and a shallow check would pass it.
 *
 * Walks values instead of serializing so it holds for fields added later, and
 * tracks visited objects so a cyclic cause chain terminates.
 */
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
const tailscaleStatusWithSingleIpJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.90.1.2"]}}`;

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

function neverFinishingMockHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
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

const serveConfig = (proxy = "http://127.0.0.1:13773", port = 8443) => ({
  TCP: { [String(port)]: { HTTPS: true } },
  Web: { [`workstation.example:${port}`]: { Handlers: { "/": { Proxy: proxy } } } },
});

function serveLayer(config: unknown, calls: Array<ReadonlyArray<string>>) {
  return layerMockSpawner((_command, args) => {
    calls.push(args);
    return args[1] === "status" ? { stdout: JSON.stringify(config) } : {};
  });
}

describe("Serve handler ownership", () => {
  it.effect.each([null, {}, serveConfig("http://127.0.0.1:9000", 9443)])(
    "configures an unused port with status %j",
    (config) => {
      const calls: Array<ReadonlyArray<string>> = [];
      return Effect.gen(function* () {
        yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 });
        assert.deepEqual(calls, [
          ["serve", "status", "--json"],
          ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
        ]);
      }).pipe(Effect.provide(serveLayer(config, calls)));
    },
  );

  it.effect("reuses its exact root proxy without a mutation", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 });
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }).pipe(Effect.provide(serveLayer(serveConfig("http://127.0.0.1:13773/"), calls)));
  });

  const matching = serveConfig();
  const protectedHandlers = [
    ["foreign root", serveConfig("http://127.0.0.1:9000")],
    [
      "additional route",
      {
        ...matching,
        Web: {
          "workstation.example:8443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:13773" },
              "/api": { Proxy: "http://127.0.0.1:9000" },
            },
          },
        },
      },
    ],
    ["Funnel", { ...matching, AllowFunnel: { "workstation.example:8443": true } }],
    ["foreground", { Foreground: { session: matching } }],
    [
      "foreground over a matching background handler",
      { ...matching, Foreground: { session: matching } },
    ],
    ["TCP forwarding", { TCP: { "8443": { TCPForward: "127.0.0.1:9000" } } }],
    [
      "application capability grants",
      {
        ...matching,
        Web: {
          "workstation.example:8443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:13773", AcceptAppCaps: ["example.com/cap/test"] },
            },
          },
        },
      },
    ],
    [
      "redirect handler",
      {
        ...matching,
        Web: {
          "workstation.example:8443": { Handlers: { "/": { Redirect: "https://example.com" } } },
        },
      },
    ],
    [
      "file serving",
      {
        ...matching,
        Web: { "workstation.example:8443": { Handlers: { "/": { Path: "/srv/example" } } } },
      },
    ],
    [
      "multiple authorities",
      {
        ...matching,
        Web: { ...matching.Web, "other.example:8443": matching.Web["workstation.example:8443"] },
      },
    ],
  ] as const;
  it.effect.each(protectedHandlers.map(([name, config]) => ({ name, config })))(
    "preserves $name during setup and cleanup",
    ({ config }) => {
      const calls: Array<ReadonlyArray<string>> = [];
      return Effect.gen(function* () {
        const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
          Effect.flip,
        );
        assert.instanceOf(error, TailscaleServePortOccupiedError);
        assert.isFalse(yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }));
        assert.deepEqual(calls, [
          ["serve", "status", "--json"],
          ["serve", "status", "--json"],
        ]);
      }).pipe(Effect.provide(serveLayer(config, calls)));
    },
  );

  it.effect.each(
    protectedHandlers
      .filter(([name]) => name !== "foreign root")
      .map(([name, config]) => ({ name, config })),
  )("does not replace $name even after environment verification", ({ config }) => {
    const calls: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({
        localPort: 13773,
        servePort: 8443,
        replaceVerifiedHandler: true,
      }).pipe(Effect.flip);
      assert.instanceOf(error, TailscaleServePortOccupiedError);
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }).pipe(Effect.provide(serveLayer(config, calls)));
  });

  it.effect("repoints only a verified simple private root proxy", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      yield* ensureTailscaleServe({
        localPort: 13773,
        servePort: 8443,
        replaceVerifiedHandler: true,
      });
      assert.deepEqual(calls.at(-1), ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"]);
    }).pipe(Effect.provide(serveLayer(serveConfig("http://127.0.0.1:9000"), calls)));
  });

  it.effect("ignores unrelated foreground sessions and Funnel ports", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 });
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }).pipe(
      Effect.provide(
        serveLayer(
          {
            ...matching,
            Foreground: { session: serveConfig("http://127.0.0.1:9000", 9443) },
            AllowFunnel: { "workstation.example:9443": true },
          },
          calls,
        ),
      ),
    );
  });

  it.effect("leaves an empty port alone during cleanup", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    return Effect.gen(function* () {
      assert.isTrue(yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }));
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }).pipe(Effect.provide(serveLayer(null, calls)));
  });

  it.effect.each(["not json", '{"TCP":42}'])(
    "refuses to mutate when Serve configuration cannot be decoded: %s",
    (stdout) => {
      const calls: Array<ReadonlyArray<string>> = [];
      return Effect.gen(function* () {
        const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
          Effect.flip,
        );
        assert.instanceOf(error, TailscaleServeStatusParseError);
        assert.deepEqual(calls, [["serve", "status", "--json"]]);
      }).pipe(
        Effect.provide(
          layerMockSpawner((_command, args) => {
            calls.push(args);
            return { stdout };
          }),
        ),
      );
    },
  );
});

describe("tailscale", () => {
  it.effect("preserves a foreign Serve handler instead of overwriting it", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const layer = layerMockSpawner((_command, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          TCP: { "8443": { HTTPS: true } },
          Web: {
            "workstation.example:8443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } },
            },
          },
        }),
      };
    });
    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(Effect.ignore);
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("detects Tailnet IPv4 addresses", () =>
    Effect.sync(() => {
      assert.equal(isTailscaleIpv4Address("100.64.0.1"), true);
      assert.equal(isTailscaleIpv4Address("100.127.255.254"), true);
      assert.equal(isTailscaleIpv4Address("100.128.0.1"), false);
      assert.equal(isTailscaleIpv4Address("192.168.1.44"), false);
    }),
  );

  it.effect("parses MagicDNS names from tailscale status", () =>
    Effect.gen(function* () {
      const dnsName = yield* parseTailscaleMagicDnsName(tailscaleStatusJson);
      assert.equal(dnsName, "desktop.tail.ts.net");
      assert.equal(yield* parseTailscaleMagicDnsName("{}"), null);
    }),
  );

  it.effect("parses status facts", () =>
    Effect.gen(function* () {
      const status = yield* parseTailscaleStatus(tailscaleStatusJson);
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.100.100.100"],
      });
    }),
  );

  it.effect("preserves status decoding failures without exposing cause text", () =>
    Effect.gen(function* () {
      const error = yield* parseTailscaleStatus("{not-json").pipe(Effect.flip);

      assert.instanceOf(error, TailscaleStatusParseError);
      assert.equal(error.message, "Failed to decode tailscale status JSON.");
      assert.isDefined(error.cause);
      assert.notInclude(error.message, String(error.cause));
    }),
  );

  it.effect("builds clean HTTPS base URLs", () =>
    Effect.sync(() => {
      assert.equal(
        buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net" }),
        "https://desktop.tail.ts.net/",
      );
      assert.equal(
        buildTailscaleHttpsBaseUrl({ magicDnsName: "desktop.tail.ts.net", servePort: 8443 }),
        "https://desktop.tail.ts.net:8443/",
      );
    }),
  );

  it.effect("reads tailscale status through the process spawner service", () => {
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["status", "--json"]);
      return {
        stdout: tailscaleStatusWithSingleIpJson,
      };
    });

    return Effect.gen(function* () {
      const status = yield* readTailscaleStatus.pipe(Effect.provide(layer));
      assert.deepEqual(status, {
        magicDnsName: "desktop.tail.ts.net",
        tailnetIpv4Addresses: ["100.90.1.2"],
      });
    });
  });

  it.effect("preserves tailscale spawn failures as causes", () => {
    const systemCause = new Error("private executable lookup detail");
    const cause = PlatformError.systemError({
      _tag: "NotFound",
      module: "ChildProcess",
      method: "spawn",
      cause: systemCause,
    });
    const layer = layerSpawner(ChildProcessSpawner.make(() => Effect.fail(cause)));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandSpawnError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Failed to spawn tailscale status.");
      assert.notInclude(error.message, systemCause.message);
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

      // What callers actually rely on: the desktop endpoint providers recover
      // with `Effect.orElseSucceed`, which only sees the typed error channel.
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

  it.effect("classifies unrecognized stderr without quoting it", () => {
    const layer = layerMockSpawner(() => ({
      code: 3,
      stderr: "something novel went wrong for node fluffy-badger tskey-auth-secret-token-value",
    }));

    return Effect.gen(function* () {
      const error = yield* readTailscaleStatus.pipe(Effect.flip, Effect.provide(layer));

      assert.instanceOf(error, TailscaleCommandExitError);
      // Unmatched stderr degrades to "unknown" rather than passing text
      // through — that fallback is what keeps novel output from leaking.
      assert.equal(error.stderrDiagnostic, "unknown");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
      assertCarriesNoSecret(error, "fluffy-badger");
    });
  });

  it.effect("times out tailscale status through TestClock", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      layerSpawner(ChildProcessSpawner.make(() => Effect.succeed(neverFinishingMockHandle()))),
    );

    return Effect.gen(function* () {
      const fiber = yield* readTailscaleStatus.pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(TAILSCALE_STATUS_TIMEOUT);
      const error = yield* Fiber.join(fiber);

      assert.instanceOf(error, TailscaleCommandTimeoutError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "status");
      assert.equal(error.argumentCount, 2);
      assert.equal(error.timeoutMs, 1_500);
      assert.isTrue(Cause.isTimeoutError(error.cause));
      assert.equal(error.message, "tailscale status timed out after 1500ms.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("configures tailscale serve through the process spawner service", () => {
    const layer = layerMockSpawner((command, args) => {
      assert.equal(command, "tailscale");
      if (args[1] === "status") return { stdout: "null" };
      assert.deepEqual(args, ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"]);
      return {};
    });

    return ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(Effect.provide(layer));
  });

  it.effect("retains tailscale serve exit diagnostics", () => {
    const layer = layerMockSpawner((_command, args) =>
      args[1] === "status"
        ? { stdout: "null" }
        : {
            code: 1,
            stderr: "serve permission denied tskey-auth-secret-token-value",
          },
    );

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );

      assert.instanceOf(error, TailscaleCommandExitError);
      assert.equal(error.executable, "tailscale");
      assert.equal(error.subcommand, "serve");
      assert.equal(error.argumentCount, 4);
      assert.equal(error.exitCode, 1);
      assert.equal(error.stderrLength, 53);
      assert.notProperty(error, "command");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
      // The diagnostic classifies the failure without quoting stderr, so the
      // key cannot reach a log through it either.
      assert.equal(error.stderrDiagnostic, "permission-denied");
      assertCarriesNoSecret(error, "tskey-auth-secret-token-value");
    });
  });

  it.effect("disables tailscale serve through the process spawner service", () => {
    const commands: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }[] = [];
    const layer = layerMockSpawner((command, args) => {
      commands.push({ command, args });
      assert.equal(command, "tailscale");
      if (args[1] === "status") return { stdout: JSON.stringify(serveConfig()) };
      assert.deepEqual(args, ["serve", "--https=8443", "off"]);
      return {};
    });

    return Effect.gen(function* () {
      assert.isTrue(
        yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
          Effect.provide(layer),
        ),
      );
      assert.deepEqual(commands, [
        { command: "tailscale", args: ["serve", "status", "--json"] },
        { command: "tailscale", args: ["serve", "--https=8443", "off"] },
      ]);
    });
  });
});
