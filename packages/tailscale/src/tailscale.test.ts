import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";

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
  TailscaleServePortOccupiedError,
  TailscaleStatusParseError,
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
const emptyServeStatusJson = `{"TCP":{},"Web":{}}`;
const serveStatusJson = (servePort: number, proxy: string) =>
  JSON.stringify({
    TCP: { [servePort]: { HTTPS: true } },
    Web: {
      [`desktop.tail.ts.net:${String(servePort)}`]: { Handlers: { "/": { Proxy: proxy } } },
    },
  });

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

function mockSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
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
    const layer = mockSpawnerLayer((command, args) => {
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
    const layer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.fail(cause)),
    );

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
    const layer = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
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
    const layer = mockSpawnerLayer(() => ({
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
    const layer = mockSpawnerLayer(() => ({
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
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(neverFinishingMockHandle())),
      ),
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
    const commands: ReadonlyArray<string>[] = [];
    const layer = mockSpawnerLayer((command, args) => {
      assert.equal(command, "tailscale");
      commands.push(args);
      if (args[1] === "status") {
        return { stdout: emptyServeStatusJson };
      }
      return {};
    });

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
      ]);
    });
  });

  it.effect("treats a null first-time serve status as unconfigured", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = mockSpawnerLayer((_command, args) => {
      commands.push(args);
      return args[1] === "status" ? { stdout: "null" } : {};
    });

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"],
      ]);
    });
  });

  it.effect("reuses only the exact existing handler", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = mockSpawnerLayer((_command, args) => {
      commands.push(args);
      return { stdout: serveStatusJson(8443, "http://127.0.0.1:13773") };
    });

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });

  it.effect("refuses to replace a configured port even when its backend differs", () => {
    const layer = mockSpawnerLayer(() => ({
      stdout: serveStatusJson(8443, "http://127.0.0.1:39831"),
    }));

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(error, TailscaleServePortOccupiedError);
      assert.equal(error.servePort, 8443);
    });
  });

  it.effect("replaces a handler only when its environment was already verified", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = mockSpawnerLayer((_command, args) => {
      commands.push(args);
      return { stdout: serveStatusJson(8443, "http://127.0.0.1:13773") };
    });

    return Effect.gen(function* () {
      yield* ensureTailscaleServe({
        localPort: 5733,
        servePort: 8443,
        replaceVerifiedHandler: true,
      }).pipe(Effect.provide(layer));
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=8443", "http://127.0.0.1:5733"],
      ]);
    });
  });

  it.effect("does not replace a complex handler after an environment probe", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = mockSpawnerLayer((_command, args) => {
      commands.push(args);
      const status = JSON.parse(serveStatusJson(8443, "http://127.0.0.1:13773")) as {
        Web: Record<string, { Handlers: Record<string, unknown> }>;
      };
      const web = status.Web["desktop.tail.ts.net:8443"];
      assert.isDefined(web);
      web.Handlers["/api"] = { Proxy: "http://127.0.0.1:39831" };
      return { stdout: JSON.stringify(status) };
    });

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({
        localPort: 5733,
        servePort: 8443,
        replaceVerifiedHandler: true,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(error, TailscaleServePortOccupiedError);
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });

  it.effect("treats a non-web listener on the selected port as occupied", () => {
    const layer = mockSpawnerLayer(() => ({
      stdout: JSON.stringify({ TCP: { 8443: { TCPForward: "127.0.0.1:39831" } }, Web: {} }),
    }));

    return Effect.gen(function* () {
      const error = yield* ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.instanceOf(error, TailscaleServePortOccupiedError);
    });
  });

  it.effect("refuses to reuse or disable a Funnel-enabled handler", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = mockSpawnerLayer((_command, args) => {
      commands.push(args);
      const status = JSON.parse(serveStatusJson(8443, "http://127.0.0.1:13773")) as Record<
        string,
        unknown
      >;
      return {
        stdout: JSON.stringify({
          ...status,
          AllowFunnel: { "desktop.tail.ts.net:8443": true },
        }),
      };
    });

    return Effect.gen(function* () {
      const ensureError = yield* ensureTailscaleServe({
        localPort: 13773,
        servePort: 8443,
        replaceVerifiedHandler: true,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(ensureError, TailscaleServePortOccupiedError);

      const disableError = yield* disableTailscaleServe({
        localPort: 13773,
        servePort: 8443,
      }).pipe(Effect.flip, Effect.provide(layer));
      assert.instanceOf(disableError, TailscaleServePortOccupiedError);
      assert.deepEqual(commands, [
        ["serve", "status", "--json"],
        ["serve", "status", "--json"],
      ]);
    });
  });

  it.effect("retains tailscale serve exit diagnostics", () => {
    const layer = mockSpawnerLayer((_command, args) =>
      args[1] === "status"
        ? { stdout: emptyServeStatusJson }
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
    const layer = mockSpawnerLayer((command, args) => {
      commands.push({ command, args });
      assert.equal(command, "tailscale");
      if (args[1] === "status") {
        return { stdout: serveStatusJson(8443, "http://127.0.0.1:13773") };
      }
      return {};
    });

    return Effect.gen(function* () {
      yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.provide(layer),
      );
      assert.deepEqual(commands, [
        { command: "tailscale", args: ["serve", "status", "--json"] },
        { command: "tailscale", args: ["serve", "--https=8443", "off"] },
      ]);
    });
  });

  it.effect("refuses to disable a handler owned by another service", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = mockSpawnerLayer((_command, args) => {
      commands.push(args);
      return { stdout: serveStatusJson(8443, "http://127.0.0.1:39831") };
    });

    return Effect.gen(function* () {
      const error = yield* disableTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(
        Effect.flip,
        Effect.provide(layer),
      );
      assert.equal(error._tag, "TailscaleServePortOccupiedError");
      assert.deepEqual(commands, [["serve", "status", "--json"]]);
    });
  });
});
