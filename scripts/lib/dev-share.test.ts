import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type DevShareError,
  DevServeFailedError,
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

/**
 * Answers `tailscale status --json` with a valid tailnet name, and lets each
 * test set the outcome of the `off` (pre-clear) and `serve` calls separately —
 * they are the same subcommand and are told apart by the trailing `off`.
 */
const spawnerLayer = (input: {
  readonly off?: CallResult;
  readonly serve?: CallResult;
  readonly calls?: Array<ReadonlyArray<string>>;
}) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = "args" in command ? (command.args as ReadonlyArray<string>) : [];
      input.calls?.push(args);
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
          stdout: args.includes("status") ? encode(TAILNET_STATUS) : Stream.empty,
          stderr: result.stderr ? encode(result.stderr) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

describe("unshareDevServer", () => {
  it.effect("treats a removed mapping as cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(spawnerLayer({ off: { exitCode: 0 } })),
      );
      assert.isTrue(result.cleared);
    }),
  );

  // `tailscale serve … off` exits 1 when the port had no mapping, which is the
  // normal first-share case — the port is clear, so this must not be an error.
  it.effect("treats a missing handler as cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(spawnerLayer({ off: { exitCode: 1, stderr: NO_HANDLER_STDERR } })),
      );
      assert.isTrue(result.cleared);
    }),
  );

  it.effect("reports a genuine removal failure as not cleared", () =>
    Effect.gen(function* () {
      const result = yield* unshareDevServer(5788).pipe(
        Effect.provide(spawnerLayer({ off: { exitCode: 1, stderr: "permission denied" } })),
      );
      assert.isFalse(result.cleared);
      assert.include(result.explanation, "permission denied");
      // Structured, so a wrapping error can keep the real chain.
      assert.equal(result.cause?._tag, "TailscaleCommandExitError");
    }),
  );
});

describe("shareDevServer", () => {
  it.effect("returns the tailnet URL for the same port", () =>
    Effect.gen(function* () {
      const shared = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ off: { exitCode: 1, stderr: NO_HANDLER_STDERR } })),
      );

      assert.equal(shared.host, "host.example.ts.net");
      assert.equal(shared.url, "https://host.example.ts.net:5788/");
    }),
  );

  // Vite binds `localhost`, which modern Node resolves to `::1` first, so a
  // 127.0.0.1 target would proxy to a loopback nothing listens on.
  it.effect("proxies to the localhost name Vite binds, not 127.0.0.1", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ off: { exitCode: 0 }, calls })),
      );

      const serveCall = calls.find((args) => args.includes("--bg"));
      assert.deepEqual(serveCall, ["serve", "--bg", "--https=5788", "http://localhost:5788"]);
    }),
  );

  // The stale-mapping clear runs before serve, so a failure here leaves the
  // port serving nothing. Saying only "serve failed" would let an operator
  // assume their previous mapping survived.
  it.effect("reports that the prior mapping was cleared when serve fails", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({
            off: { exitCode: 0 },
            serve: { exitCode: 1, stderr: "port already in use" },
          }),
        ),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.stage, "serve");
      assert.equal(error.webPort, 5788);
      // The underlying failure is preserved rather than flattened to a string.
      assert.equal(
        (error.cause as { _tag?: string } | undefined)?._tag,
        "TailscaleCommandExitError",
      );
      // Unclassifiable stderr is never quoted (it can carry auth keys), so the
      // message points at the command instead of echoing the CLI.
      assert.notInclude(error.message, "port already in use");
      assert.include(error.message, "run the command by hand");
      assert.include(error.message, "no longer served");
      assert.include(error.message, "5788");
    }),
  );

  // A recognized failure gets our own wording for it — enough to act on
  // without passing CLI text through.
  it.effect("explains a recognized serve failure without quoting stderr", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(
          spawnerLayer({
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

  // Serving over routes we could not remove yields a URL that loads but whose
  // /ws and /api quietly point at a dead backend.
  it.effect("refuses to serve when the existing mapping could not be cleared", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* shareDevServer({ webPort: 5788 }).pipe(
        Effect.provide(spawnerLayer({ off: { exitCode: 1, stderr: "permission denied" } })),
        Effect.flip,
      );

      assert.instanceOf(error, DevServeFailedError);
      // A distinct stage: the prior mapping survived, so nothing was replaced.
      assert.equal(error.stage, "clear-existing");
      assert.include(error.message, "could not clear the existing mapping");
      assert.include(error.message, "permission denied");
    }),
  );
});
