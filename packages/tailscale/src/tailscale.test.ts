import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import { TailscaleExecutableProbe } from "./executable.ts";
import {
  buildTailscaleHttpsBaseUrl,
  disableTailscaleServe,
  ensureTailscaleServe,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  parseTailscaleStatus,
  probeTailscaleServeEndpoint,
  readTailscaleServeConfig,
  readTailscaleStatus,
  TAILSCALE_STATUS_TIMEOUT,
  TailscaleCommandExitError,
  TailscaleCommandSpawnError,
  TailscaleCommandTimeoutError,
  TailscaleStatusParseError,
} from "./tailscale.ts";

// Discovery is exercised in executable.test.ts; pin it to "not found" here so
// these assertions describe the command, not the host the suite runs on.
const noInstalledCli = Layer.succeed(TailscaleExecutableProbe, () => false);

const encoder = new TextEncoder();
const tailscaleStatusJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.100.100.100","fd7a:115c:a1e0::1","192.168.1.20"]}}`;
const tailscaleStatusWithSingleIpJson = `{"Self":{"DNSName":"desktop.tail.ts.net.","TailscaleIPs":["100.90.1.2"]}}`;
const tailscaleServeStatusJson = `{"Web":{"m1-dev.tail.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:80"}}}}}`;

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
  return Layer.merge(
    noInstalledCli,
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) => {
        const childProcess = command as unknown as {
          readonly command: string;
          readonly args: ReadonlyArray<string>;
        };
        return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
      }),
    ),
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
    const layer = Layer.merge(
      noInstalledCli,
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(cause)),
      ),
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
    });
  });

  it.effect("times out tailscale status through TestClock", () => {
    const layer = Layer.mergeAll(
      TestClock.layer(),
      noInstalledCli,
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
    const layer = mockSpawnerLayer((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["serve", "--bg", "--https=8443", "http://127.0.0.1:13773"]);
      return {};
    });

    return ensureTailscaleServe({ localPort: 13773, servePort: 8443 }).pipe(Effect.provide(layer));
  });

  it.effect("retains tailscale serve exit diagnostics", () => {
    const layer = mockSpawnerLayer(() => ({
      code: 1,
      stderr: "serve permission denied tskey-auth-secret-token-value",
    }));

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
      assert.deepEqual(args, ["serve", "--https=8443", "off"]);
      return {};
    });

    return Effect.gen(function* () {
      yield* disableTailscaleServe({ servePort: 8443 }).pipe(Effect.provide(layer));
      assert.deepEqual(commands, [
        { command: "tailscale", args: ["serve", "--https=8443", "off"] },
      ]);
    });
  });

  it.effect("spawns the discovered CLI path when tailscale is off PATH", () => {
    const macAppCli = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
    const layer = Layer.merge(
      Layer.succeed(TailscaleExecutableProbe, (candidate) => candidate === macAppCli),
      Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          const childProcess = command as unknown as { readonly command: string };
          assert.equal(childProcess.command, macAppCli);
          return Effect.succeed(mockHandle({ stdout: tailscaleStatusJson }));
        }),
      ),
    );

    return readTailscaleStatus.pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(HostProcessEnvironment, { PATH: "/usr/bin:/bin" }),
      Effect.provide(layer),
      Effect.asVoid,
    );
  });

  it.effect("reads the existing serve config", () => {
    const layer = mockSpawnerLayer((command, args) => {
      assert.equal(command, "tailscale");
      assert.deepEqual(args, ["serve", "status", "--json"]);
      return { stdout: tailscaleServeStatusJson };
    });

    return Effect.gen(function* () {
      const mounts = yield* readTailscaleServeConfig.pipe(Effect.provide(layer));
      assert.deepEqual(mounts, [{ port: 443, proxyTargets: ["http://127.0.0.1:80"] }]);
    });
  });

  describe("serve endpoint probe", () => {
    const probeLayer = (respond: (url: string) => Response) =>
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url))),
        ),
      );

    const jsonResponse = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    it.effect("accepts the endpoint when this environment answers", () =>
      Effect.gen(function* () {
        const result = yield* probeTailscaleServeEndpoint({
          baseUrl: "https://m1-dev.tail.ts.net/",
          expectedEnvironmentId: "env-1",
        }).pipe(
          Effect.provide(
            probeLayer((url) => {
              assert.equal(url, "https://m1-dev.tail.ts.net/.well-known/t3/environment");
              return jsonResponse({ environmentId: "env-1" });
            }),
          ),
        );

        assert.deepEqual(result, { ok: true });
      }),
    );

    // Exactly the reported symptom: nginx owns the MagicDNS name's :443.
    it.effect("rejects a host serving something else", () =>
      Effect.gen(function* () {
        const result = yield* probeTailscaleServeEndpoint({
          baseUrl: "https://m1-dev.tail.ts.net/",
          expectedEnvironmentId: "env-1",
        }).pipe(
          Effect.provide(
            probeLayer(() => new Response("<html>404 Not Found</html>", { status: 404 })),
          ),
        );

        assert.deepEqual(result, { ok: false, reason: "http-status", status: 404 });
      }),
    );

    it.effect("rejects a 200 that is not an environment descriptor", () =>
      Effect.gen(function* () {
        const result = yield* probeTailscaleServeEndpoint({
          baseUrl: "https://m1-dev.tail.ts.net/",
          expectedEnvironmentId: "env-1",
        }).pipe(Effect.provide(probeLayer(() => new Response("<html>hi</html>", { status: 200 }))));

        assert.deepEqual(result, { ok: false, reason: "not-an-environment", status: 200 });
      }),
    );

    it.effect("rejects a different environment answering on this hostname", () =>
      Effect.gen(function* () {
        const result = yield* probeTailscaleServeEndpoint({
          baseUrl: "https://m1-dev.tail.ts.net/",
          expectedEnvironmentId: "env-1",
        }).pipe(Effect.provide(probeLayer(() => jsonResponse({ environmentId: "env-2" }))));

        assert.deepEqual(result, {
          ok: false,
          reason: "environment-mismatch",
          environmentId: "env-2",
        });
      }),
    );

    it.effect("treats a transport failure as unreachable", () =>
      Effect.gen(function* () {
        const result = yield* probeTailscaleServeEndpoint({
          baseUrl: "https://m1-dev.tail.ts.net/",
          expectedEnvironmentId: "env-1",
        }).pipe(
          Effect.provide(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make(() => Effect.die(new Error("connection refused"))),
            ),
          ),
        );

        assert.deepEqual(result, { ok: false, reason: "unreachable" });
      }),
    );
  });
});
