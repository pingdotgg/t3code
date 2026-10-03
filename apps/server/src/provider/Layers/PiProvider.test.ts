import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { checkPiProviderStatus, MINIMUM_PI_VERSION } from "./PiProvider.ts";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";

const encoder = new TextEncoder();
const decodeRpcRequest = Schema.decodeSync(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, type: Schema.String })),
);
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

const piDiscoverySpawner = (inventory: unknown) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    let stdinBuffer = "";
    const stdin = Sink.forEach((chunk: Uint8Array) =>
      Effect.gen(function* () {
        stdinBuffer += new TextDecoder().decode(chunk);
        while (true) {
          const newline = stdinBuffer.indexOf("\n");
          if (newline === -1) return;
          const line = stdinBuffer.slice(0, newline);
          stdinBuffer = stdinBuffer.slice(newline + 1);
          if (line.length === 0) continue;
          const request = decodeRpcRequest(line);
          const data =
            request.type === "get_available_models"
              ? inventory
              : request.type === "get_commands"
                ? { commands: [] }
                : {};
          yield* Queue.offer(
            stdout,
            encoder.encode(
              `${encodeJsonLine({ type: "response", id: request.id, command: request.type, success: true, data })}\n`,
            ),
          );
        }
      }),
    );
    return ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      return Effect.succeed(
        args.includes("--version")
          ? processHandle({ stdout: "pi 0.84.3\n" })
          : ChildProcessSpawner.makeHandle({
              ...processHandle({}),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              stdin,
              stdout: Stream.fromQueue(stdout),
            }),
      );
    });
  });

const piInstance = {
  instanceId: ProviderInstanceId.make("pi-personal"),
  driver: ProviderDriverKind.make("pi"),
};

const previousModels = [
  { slug: "default", name: "Pi default", isCustom: false, capabilities: null },
  { slug: "openrouter/openai/gpt-5", name: "GPT-5", isCustom: false, capabilities: null },
  {
    slug: "anthropic/claude-sonnet-4",
    name: "Claude Sonnet 4",
    isCustom: false,
    capabilities: null,
  },
] as const satisfies ServerProvider["models"];

const settings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
} as const;

describe("PiProvider", () => {
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
      const nextProvider = { ...snapshot, ...piInstance };
      assert.deepEqual(
        mergeProviderSnapshot({ ...nextProvider, models: previousModels }, nextProvider).models.map(
          (model) => model.slug,
        ),
        previousModels.map((model) => model.slug),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes logged-out OpenRouter models after successful Pi discovery", () =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner({
        models: [{ provider: "anthropic", id: "claude-sonnet-4" }],
      });
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "authenticated");
      const nextProvider = { ...snapshot, ...piInstance };
      assert.deepEqual(
        mergeProviderSnapshot({ ...nextProvider, models: previousModels }, nextProvider).models.map(
          (model) => model.slug,
        ),
        ["default", "anthropic/claude-sonnet-4"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("clears discovered models when successful Pi discovery returns no usable models", () =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner({ models: [] });
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "unauthenticated");
      const nextProvider = { ...snapshot, ...piInstance };
      assert.deepEqual(
        mergeProviderSnapshot({ ...nextProvider, models: previousModels }, nextProvider).models.map(
          (model) => model.slug,
        ),
        ["default"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    ["missing models", {}],
    ["non-array models", { models: {} }],
    ["missing model provider", { models: [{ id: "claude-sonnet-4" }] }],
    ["missing model id", { models: [{ provider: "anthropic" }] }],
    ["empty model provider", { models: [{ provider: "", id: "claude-sonnet-4" }] }],
    ["empty model id", { models: [{ provider: "anthropic", id: "" }] }],
    [
      "mixed valid and invalid models",
      { models: [{ provider: "anthropic", id: "claude-sonnet-4" }, { provider: "openrouter" }] },
    ],
  ] as const)("retains cached models when Pi discovery returns %s", (_label, inventory) =>
    Effect.gen(function* () {
      const spawner = yield* piDiscoverySpawner(inventory);
      const snapshot = yield* checkPiProviderStatus(settings).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const nextProvider = { ...snapshot, ...piInstance };
      assert.deepEqual(
        mergeProviderSnapshot({ ...nextProvider, models: previousModels }, nextProvider).models.map(
          (model) => model.slug,
        ),
        previousModels.map((model) => model.slug),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.auth.status, "unknown");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
