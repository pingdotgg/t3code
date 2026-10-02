import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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

function piDiscoverySpawner() {
  return ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args : [];
    if (args.includes("--version")) {
      return Effect.succeed(processHandle({ stdout: "pi 1.0.0\n" }));
    }
    return Effect.gen(function* () {
      const output = yield* Queue.unbounded<Uint8Array>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(900_000_002),
        exitCode: Deferred.await(exited),
        isRunning: Effect.succeed(true),
        kill: () => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) => {
          const request = JSON.parse(new TextDecoder().decode(bytes));
          const data =
            request.type === "get_available_models"
              ? {
                  models: [
                    { provider: "openai-codex-work", id: "gpt-6-luna", name: "GPT-6 Luna" },
                    { provider: "openai-codex-personal", id: "gpt-6-luna", name: "GPT-6 Luna" },
                  ],
                }
              : request.type === "get_commands"
                ? { commands: [] }
                : {};
          return Queue.offer(
            output,
            encoder.encode(
              JSON.stringify({
                type: "response",
                id: request.id,
                success: true,
                data,
              }) + "\n",
            ),
          );
        }),
        stdout: Stream.fromQueue(output),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    });
  });
}

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
  it.effect("preserves native provider labels for identically named Pi models", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, piDiscoverySpawner()),
      );
      assert.equal(snapshot.status, "ready");
      assert.deepEqual(
        snapshot.models
          .filter((model) => model.name === "GPT-6 Luna")
          .map((model) => ({
            slug: model.slug,
            subProvider: model.subProvider,
          })),
        [
          { slug: "openai-codex-work/gpt-6-luna", subProvider: "openai-codex-work" },
          { slug: "openai-codex-personal/gpt-6-luna", subProvider: "openai-codex-personal" },
        ],
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
