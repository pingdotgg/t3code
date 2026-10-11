import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { DevServeFailedError, shareDevServer, unshareDevServer } from "./dev-share.ts";

const TAILNET_STATUS = JSON.stringify({ Self: { DNSName: "host.example.ts.net." } });
const serveConfig = (proxy = "http://localhost:5788") =>
  JSON.stringify({
    TCP: { "5788": { HTTPS: true } },
    Web: { "host.example.ts.net:5788": { Handlers: { "/": { Proxy: proxy } } } },
  });

interface CallResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

const encode = (value: string) => Stream.make(new TextEncoder().encode(value));

/** Mocks only the CLI boundary, distinguishing node status from serve config. */
const spawnerLayer = (input: {
  readonly config?: string;
  readonly configRead?: CallResult;
  readonly off?: CallResult;
  readonly serve?: CallResult;
  readonly calls?: Array<ReadonlyArray<string>>;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = "args" in command ? (command.args as ReadonlyArray<string>) : [];
      input.calls?.push(args);
      const result: CallResult =
        args[0] === "status"
          ? { exitCode: 0, stdout: TAILNET_STATUS }
          : args[1] === "status"
            ? (input.configRead ?? { exitCode: 0, stdout: input.config ?? "{}" })
            : args.includes("off")
              ? (input.off ?? { exitCode: 0 })
              : (input.serve ?? { exitCode: 0 });

      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: result.stdout ? encode(result.stdout) : Stream.empty,
          stderr: result.stderr ? encode(result.stderr) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

describe("unshareDevServer", () => {
  it.effect("removes the matching localhost proxy", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(spawnerLayer({ config: serveConfig(), calls })),
      );
      assert.isTrue(result.cleared);
      assert.deepEqual(calls, [
        ["serve", "status", "--json"],
        ["serve", "--https=5788", "off"],
      ]);
    }),
  );

  it.effect.each(["null", "{}"])("treats %s as clear without removing anything", (config) =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(spawnerLayer({ config, calls })),
      );
      assert.isTrue(result.cleared);
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }),
  );

  it.effect("preserves a foreign proxy and reports the port still occupied", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(spawnerLayer({ config: serveConfig("http://localhost:9000"), calls })),
      );
      assert.isFalse(result.cleared);
      assert.isUndefined(result.cause);
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }),
  );

  it.effect("preserves additional routes even when the root proxy matches", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const config = JSON.stringify({
        TCP: { "5788": { HTTPS: true } },
        Web: {
          "host.example.ts.net:5788": {
            Handlers: {
              "/": { Proxy: "http://localhost:5788" },
              "/api": { Proxy: "http://localhost:9000" },
            },
          },
        },
      });
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(spawnerLayer({ config, calls })),
      );
      assert.isFalse(result.cleared);
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }),
  );

  it.effect("does not remove anything when reading configuration fails", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(
          spawnerLayer({ configRead: { exitCode: 1, stderr: "permission denied" }, calls }),
        ),
      );
      assert.isFalse(result.cleared);
      assert.equal(result.cause?._tag, "TailscaleCommandExitError");
      assert.include(result.explanation, "permission denied");
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }),
  );

  it.effect("keeps the removal failure and explains it without exposing stderr", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(
          spawnerLayer({
            config: serveConfig(),
            off: { exitCode: 1, stderr: "permission denied for tskey-auth-secret" },
          }),
        ),
      );
      assert.isFalse(result.cleared);
      assert.include(result.explanation, "permission denied");
      assert.notInclude(result.explanation, "tskey-auth-secret");
      assert.equal(result.cause?._tag, "TailscaleCommandExitError");
    }),
  );

  it.effect("does not remove anything when serve configuration cannot be decoded", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(spawnerLayer({ config: "invalid json", calls })),
      );
      assert.isFalse(result.cleared);
      assert.equal(result.cause?._tag, "TailscaleServeStatusParseError");
      assert.include(result.explanation, "configuration");
      assert.deepEqual(calls, [["serve", "status", "--json"]]);
    }),
  );
});

describe("shareDevServer", () => {
  it.effect("shares the localhost name Vite binds without pre-clearing", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const shared = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ calls })),
      );
      assert.equal(shared.host, "host.example.ts.net");
      assert.equal(shared.url, "https://host.example.ts.net:5788/");
      assert.deepEqual(calls, [
        ["status", "--json"],
        ["serve", "status", "--json"],
        ["serve", "--bg", "--https=5788", "http://localhost:5788"],
      ]);
    }),
  );

  it.effect("reuses the matching localhost proxy without changing it", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const shared = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ config: serveConfig(), calls })),
      );
      assert.equal(shared.url, "https://host.example.ts.net:5788/");
      assert.deepEqual(calls, [
        ["status", "--json"],
        ["serve", "status", "--json"],
      ]);
    }),
  );

  it.effect("preserves an occupied port and explains how to choose another dev port", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const error = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ config: serveConfig("http://localhost:9000"), calls })),
        Effect.flip,
      );
      assert.instanceOf(error, DevServeFailedError);
      assert.equal((error.cause as { _tag?: string })._tag, "TailscaleServePortOccupiedError");
      assert.include(error.message, "preserved");
      assert.include(error.message, "T3CODE_PORT_OFFSET");
      assert.deepEqual(calls, [
        ["status", "--json"],
        ["serve", "status", "--json"],
      ]);
    }),
  );

  it.effect.each(["permission denied for tskey-auth-secret", "port already in use"])(
    "safely wraps a serve command failure (%s)",
    (stderr) =>
      Effect.gen(function* () {
        const error = yield* shareDevServer({ webPort: 5788 }).pipe(
          Effect.provide(spawnerLayer({ serve: { exitCode: 1, stderr } })),
          Effect.flip,
        );
        assert.instanceOf(error, DevServeFailedError);
        assert.equal((error.cause as { _tag?: string })._tag, "TailscaleCommandExitError");
        assert.include(error.message, "5788");
        assert.notInclude(error.message, "tskey-auth-secret");
        assert.notInclude(error.message, "cleared");
        assert.include(
          error.message,
          stderr.startsWith("permission") ? "elevated privileges" : "run the command by hand",
        );
      }),
  );

  it.effect("wraps a configuration parse failure without changing handlers", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const error = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ config: "invalid json", calls })),
        Effect.flip,
      );
      assert.instanceOf(error, DevServeFailedError);
      assert.equal((error.cause as { _tag?: string })._tag, "TailscaleServeStatusParseError");
      assert.include(error.message, "configuration");
      assert.deepEqual(calls, [
        ["status", "--json"],
        ["serve", "status", "--json"],
      ]);
    }),
  );
});
