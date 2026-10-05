import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import { TestClock } from "effect/testing";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkPiProviderStatus, MINIMUM_PI_VERSION } from "./PiProvider.ts";

const encoder = new TextEncoder();

function processHandle(input: {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}) {
  const bytes = (value: string | undefined) =>
    value === undefined || value.length === 0
      ? Stream.empty
      : Stream.succeed(encoder.encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(900_000_001),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout),
    stderr: bytes(input.stderr),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function piProbeSpawner(version: string) {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    return Effect.succeed(
      args.includes("--version")
        ? processHandle({ stdout: `pi ${version}\n` })
        : processHandle({ stderr: "RPC startup failed", exitCode: 1 }),
    );
  });
}

function delayedPiProbeSpawner(startupDelayMs: number, started: Deferred.Deferred<void>) {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      if (args.includes("--version")) return processHandle({ stdout: "pi 0.99.1\n" });
      assert.include(args, "--no-session");
      assert.notInclude(args, "--no-extensions");
      const responses = yield* Queue.unbounded<Uint8Array>();
      return ChildProcessSpawner.makeHandle({
        ...processHandle({}),
        exitCode: Effect.never,
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.gen(function* () {
            const request = JSON.parse(new TextDecoder().decode(chunk)) as {
              id: string;
              type: string;
            };
            if (request.type === "get_state") {
              yield* Deferred.succeed(started, undefined);
              yield* Effect.sleep(startupDelayMs);
            }
            const data =
              request.type === "get_available_models"
                ? { models: [{ provider: "extension-provider", id: "custom-model" }] }
                : request.type === "get_commands"
                  ? { commands: [] }
                  : {};
            yield* Queue.offer(
              responses,
              encoder.encode(
                `${JSON.stringify({ type: "response", id: request.id, success: true, data })}\n`,
              ),
            );
          }),
        ),
        stdout: Stream.fromQueue(responses),
      });
    }),
  );
}

const settings = {
  enabled: true,
  binaryPath: "pi-test",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("discovers extension models when RPC startup takes more than 15 seconds", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const probe = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          delayedPiProbeSpawner(20_000, started),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("20 seconds");
      const snapshot = yield* Fiber.join(probe);
      assert.equal(snapshot.auth.status, "authenticated");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default", "extension-provider/custom-model"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("still falls back when RPC startup exceeds the discovery deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const probe = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          delayedPiProbeSpawner(60_000, started),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* TestClock.adjust("31 seconds");
      const snapshot = yield* Fiber.join(probe);
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("requires the first published Pi version with entries and settlement hooks", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.80.3")),
      );
      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.version, "0.80.3");
      assert.include(snapshot.message ?? "", `Pi ${MINIMUM_PI_VERSION} or newer`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps compatible Pi selectable when optional discovery fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piProbeSpawner("0.84.3")),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
      assert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["default"],
      );
      assert.include(snapshot.message ?? "", "could not refresh its models and commands");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
