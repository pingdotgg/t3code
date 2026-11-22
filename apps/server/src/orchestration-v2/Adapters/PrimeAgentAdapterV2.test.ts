import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import { PrimeAgentSettings } from "@t3tools/provider-prime-agent/settings";
import {
  makePrimeAgentAdapterV2,
  PRIME_AGENT_PROVIDER_OPTION_ID,
  PRIME_AGENT_RLM_DEPTH_OPTION_ID,
  PRIME_AGENT_THINKING_OPTION_ID,
} from "@t3tools/provider-prime-agent/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const instanceId = ProviderInstanceId.make("primeAgent");
const ENABLED_SETTINGS = Schema.decodeSync(PrimeAgentSettings)({
  enabled: true,
  binaryPath: "/mock/prime-agent",
});
const decodeRuntimePolicy = Schema.decodeSync(ProviderAdapterV2RuntimePolicy);
const encoder = new TextEncoder();
const decodeRpc = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
      method: Schema.optional(Schema.String),
    }),
  ),
);

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly rlmMaxDepth: string | undefined;
  readonly primeApiKey: string | undefined;
}

/** Fake `prime-agent --mode acp` process that handles initialize + session/new and records argv/env. */
function makeFakePrimeAgentSpawner(records: Array<SpawnRecord>, sessionId: string) {
  let pidCounter = 910_000;
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const standard = ChildProcess.isStandardCommand(command);
      if (standard && !command.command.includes("prime-agent")) {
        // Non-prime-agent helper commands (such as Windows taskkill on teardown) exit immediately.
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(++pidCounter),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
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
      if (standard) {
        const readEnv = (value: unknown): string | undefined =>
          typeof value === "string" ? value : undefined;
        records.push({
          command: command.command,
          args: command.args.map((arg) => (typeof arg === "string" ? arg : String(arg))),
          cwd: command.options.cwd,
          rlmMaxDepth: readEnv(command.options.env?.RLM_MAX_DEPTH),
          primeApiKey: readEnv(command.options.env?.PRIME_API_KEY),
        });
      }
      const stdoutQueue = yield* Queue.unbounded<Uint8Array>();
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const terminate = Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(
        Effect.andThen(Queue.shutdown(stdoutQueue)),
        Effect.asVoid,
      );
      const handleLine = (line: string) => {
        const msg = decodeRpc(line);
        if (msg.id === undefined || msg.method === undefined) return Effect.void;
        const result =
          msg.method === "initialize"
            ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
            : msg.method === "session/new"
              ? { sessionId }
              : {};
        return Queue.offer(
          stdoutQueue,
          encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`),
        );
      };
      pidCounter += 1;
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(pidCounter),
        exitCode: Deferred.await(exited),
        isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
        kill: () => terminate,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.forEach(
            new TextDecoder()
              .decode(bytes)
              .split("\n")
              .filter((line) => line.trim().length > 0),
            handleLine,
          ),
        ),
        stdout: Stream.fromQueue(stdoutQueue),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

describe("PrimeAgentAdapterV2", () => {
  it.effect("plans restart_session when model, thinking, or RLM depth changes mid-thread", () =>
    Effect.gen(function* () {
      const selfInvocation = yield* resolveSelfInvocation();
      const adapter = yield* makePrimeAgentAdapterV2({
        instanceId,
        settings: ENABLED_SETTINGS,
        environment: { PRIME_API_KEY: "pk_test" },
        selfInvocation,
      });
      const capabilities = yield* adapter.getCapabilities();
      const current: ModelSelection = {
        instanceId,
        model: "claude-sonnet-4-5",
        options: [
          { id: PRIME_AGENT_PROVIDER_OPTION_ID, value: "anthropic" },
          { id: PRIME_AGENT_THINKING_OPTION_ID, value: "medium" },
          { id: PRIME_AGENT_RLM_DEPTH_OPTION_ID, value: "2" },
        ],
      };

      const unchanged = yield* adapter.planSelectionTransition({
        current,
        target: current,
        sessionCapabilities: capabilities,
      });
      assert.deepEqual(unchanged, { type: "apply_on_next_turn" });

      const thinkingChanged = yield* adapter.planSelectionTransition({
        current,
        target: {
          ...current,
          options: [
            { id: PRIME_AGENT_PROVIDER_OPTION_ID, value: "anthropic" },
            { id: PRIME_AGENT_THINKING_OPTION_ID, value: "high" },
            { id: PRIME_AGENT_RLM_DEPTH_OPTION_ID, value: "2" },
          ],
        },
        sessionCapabilities: capabilities,
      });
      assert.deepEqual(thinkingChanged, { type: "restart_session" });

      const modelChanged = yield* adapter.planSelectionTransition({
        current,
        target: { ...current, model: "gpt-5" },
        sessionCapabilities: capabilities,
      });
      assert.deepEqual(modelChanged, { type: "restart_session" });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("spawns with startup flags and reattaches via --resume on session replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "prime-agent-test-" });
        const records: Array<SpawnRecord> = [];
        const spawner = makeFakePrimeAgentSpawner(records, "prime-sess-42");
        const selfInvocation = yield* resolveSelfInvocation();
        const adapter = yield* makePrimeAgentAdapterV2({
          instanceId,
          settings: ENABLED_SETTINGS,
          environment: { PRIME_API_KEY: "pk_secret" },
          selfInvocation,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const runtimePolicy = decodeRuntimePolicy({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: repoDir,
        });

        // 1. Initial session launch in target workspace directory.
        yield* Effect.scoped(
          adapter
            .openSession({
              providerSessionId: ProviderSessionId.make("psess-1"),
              threadId: ThreadId.make("thread-1"),
              modelSelection: {
                instanceId,
                model: "claude-sonnet-4-5",
                options: [
                  { id: PRIME_AGENT_PROVIDER_OPTION_ID, value: "anthropic" },
                  { id: PRIME_AGENT_THINKING_OPTION_ID, value: "medium" },
                  { id: PRIME_AGENT_RLM_DEPTH_OPTION_ID, value: "2" },
                ],
              },
              runtimePolicy,
            })
            .pipe(Effect.asVoid),
        );

        // 2. Replacement session after model/thinking/RLM change reattaches via --resume.
        yield* Effect.scoped(
          adapter
            .openSession({
              providerSessionId: ProviderSessionId.make("psess-2"),
              threadId: ThreadId.make("thread-1"),
              initialNativeThreadId: "prime-sess-42",
              modelSelection: {
                instanceId,
                model: "claude-opus-4-6",
                options: [
                  { id: PRIME_AGENT_PROVIDER_OPTION_ID, value: "anthropic" },
                  { id: PRIME_AGENT_THINKING_OPTION_ID, value: "high" },
                  { id: PRIME_AGENT_RLM_DEPTH_OPTION_ID, value: "0" },
                ],
              },
              runtimePolicy,
            })
            .pipe(Effect.asVoid),
        );

        assert.equal(records.length, 2);
        assert.deepEqual(records[0]?.args, [
          "--mode",
          "acp",
          "--provider",
          "anthropic",
          "--model",
          "claude-sonnet-4-5",
          "--thinking",
          "medium",
        ]);
        assert.equal(records[0]?.cwd, repoDir);
        assert.equal(records[0]?.rlmMaxDepth, "2");
        assert.equal(records[0]?.primeApiKey, "pk_secret");

        assert.deepEqual(records[1]?.args, [
          "--mode",
          "acp",
          "--provider",
          "anthropic",
          "--model",
          "claude-opus-4-6",
          "--thinking",
          "high",
          "--resume",
          "prime-sess-42",
        ]);
        assert.equal(records[1]?.rlmMaxDepth, "0");
      }),
    ).pipe(Effect.provide(testLayer)),
  );
});
