import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import {
  type DevShareError,
  DevServeFailedError,
  DevSharePortTakenError,
  shareDevServer,
  unshareDevServer,
} from "./dev-share.ts";

const TAILNET_STATUS = JSON.stringify({ Self: { DNSName: "host.example.ts.net." } });
const NO_HANDLER_STDERR = "error: failed to remove web serve: handler does not exist";

interface CallResult {
  readonly exitCode: number;
  readonly stderr?: string;
}

const encode = (value: string) => Stream.make(new TextEncoder().encode(value));

/** `tailscale serve status --json` for a machine forwarding `servePort` to `target`. */
const serveStatus = (servePort: number, target: string) =>
  JSON.stringify({
    TCP: { [servePort]: { HTTPS: true } },
    Web: { [`host.example.ts.net:${servePort}`]: { Handlers: { "/": { Proxy: target } } } },
  });

const spawnerLayer = (input: {
  readonly off?: CallResult;
  readonly serve?: CallResult;
  readonly serveStatus?: string;
  readonly calls?: Array<ReadonlyArray<string>>;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = "args" in command ? (command.args as ReadonlyArray<string>) : [];
      input.calls?.push(args);
      const isServeStatus = args[0] === "serve" && args[1] === "status";
      const result: CallResult = args.includes("status")
        ? { exitCode: 0 }
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
          stdout: isServeStatus
            ? encode(input.serveStatus ?? "{}")
            : args.includes("status")
              ? encode(TAILNET_STATUS)
              : Stream.empty,
          stderr: result.stderr ? encode(result.stderr) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

/** Answers for targets in `live`; anything else refuses the connection. */
const httpLayer = (live: ReadonlyArray<string> = []) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      live.some((target) => request.url.startsWith(target))
        ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
        : Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request }),
            }),
          ),
    ),
  );

const tailscale = (input: Parameters<typeof spawnerLayer>[0], live?: ReadonlyArray<string>) =>
  Layer.merge(spawnerLayer(input), httpLayer(live));

const OURS = "http://localhost:5788";

describe("unshareDevServer", () => {
  // `tailscale serve … off` exits 1 when the port had no mapping, which is the
  // normal first-share case — the port is clear, so this must not be an error.
  it.effect("treats a missing handler as cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          tailscale({
            serveStatus: serveStatus(5788, OURS),
            off: { exitCode: 1, stderr: NO_HANDLER_STDERR },
          }),
        ),
      );
      assert.isTrue(result.cleared);
    }),
  );

  it.effect("reports a genuine removal failure as not cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          tailscale({
            serveStatus: serveStatus(5788, OURS),
            off: { exitCode: 1, stderr: "permission denied" },
          }),
        ),
      );
      assert.isFalse(result.cleared);
      assert.include(result.explanation, "permission denied");
      assert.equal(result.cause?._tag, "TailscaleCommandExitError");
    }),
  );

  // Another server took the port after this one shared it; removing the mapping
  // on the way out would cut off that server's remote clients.
  it.effect("leaves a mapping that now forwards to another server", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* unshareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          tailscale({ serveStatus: serveStatus(5788, "http://127.0.0.1:3773"), calls }),
        ),
      );
      assert.deepEqual(result, { cleared: true, notOurs: true });
      assert.isFalse(calls.some((args) => args.includes("off")));
    }),
  );

  it.effect("leaves the mapping when serve status cannot be read", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const result = yield* unshareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(tailscale({ serveStatus: "not json", calls })),
      );
      assert.isFalse(result.cleared);
      assert.isFalse(calls.some((args) => args.includes("off")));
    }),
  );
});

describe("shareDevServer", () => {
  // Vite binds `localhost`, which modern Node resolves to `::1` first, so a
  // 127.0.0.1 target would proxy to a loopback nothing listens on.
  it.effect("proxies to the localhost name Vite binds, not 127.0.0.1", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(tailscale({ off: { exitCode: 0 }, calls })),
      );

      const serveCall = calls.find((args) => args.includes("--bg"));
      assert.deepEqual(serveCall, ["serve", "--bg", "--https=5788", "http://localhost:5788"]);
    }),
  );

  it.effect("explains a recognized serve failure without quoting stderr", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          tailscale({
            off: { exitCode: 0 },
            serve: {
              exitCode: 1,
              stderr: "permission denied for tskey-auth-secret-token-value",
            },
          }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.stage, "serve");
      assert.include(error.message, "permission denied");
      assert.include(error.message, "elevated privileges");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
    }),
  );

  it.effect("refuses to serve when the existing mapping could not be cleared", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          tailscale({
            serveStatus: serveStatus(5788, "http://127.0.0.1:4077"),
            off: { exitCode: 1, stderr: "permission denied" },
          }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.stage, "clear-existing");
      assert.include(error.message, "could not clear the existing mapping");
      assert.include(error.message, "permission denied");
    }),
  );

  // The 2026-10-24 outage: a port already forwarding to a live server was
  // re-pointed at a dev server, and every remote client got 502.
  it.effect("refuses a port that forwards to another live server", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          tailscale({ serveStatus: serveStatus(5788, "http://127.0.0.1:3773"), calls }, [
            "http://127.0.0.1:3773",
          ]),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevSharePortTakenError);
      assert.include(error.message, "http://127.0.0.1:3773");
      assert.isFalse(calls.some((args) => args.includes("off") || args.includes("--bg")));
    }),
  );

  it.effect("replaces a stale mapping whose target no longer answers", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          tailscale({ serveStatus: serveStatus(5788, "http://127.0.0.1:4077"), calls }),
        ),
      );

      assert.deepEqual(
        calls.filter((args) => args.includes("off") || args.includes("--bg")),
        [
          ["serve", "--https=5788", "--set-path=/", "off"],
          ["serve", "--bg", "--https=5788", "http://localhost:5788"],
        ],
      );
    }),
  );
});
