import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type ProviderKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import {
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Shape,
} from "../ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./ProviderReplayHarness.ts";
import { makeCheckpointWorkspace } from "./ReplayFixtureWorkspace.ts";

const threadId = ThreadId.make("thread:provider-switch");
const projectId = ProjectId.make("project:provider-switch");
const firstPrompt = "Respond with exactly: codex before switch";
const claudePrompt = "Respond with exactly: claude switched response";
const returnPrompt = "Respond with exactly: codex after return";

interface CapturedTurn {
  readonly provider: ProviderKind;
  readonly providerThreadId: ProviderThreadId;
  readonly text: string;
}

function unimplemented(provider: ProviderKind, detail: string) {
  return Effect.fail(new ProviderAdapterProtocolError({ provider, detail }));
}

function makeTestAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly modelSelection: ModelSelection;
  readonly responseByRunOrdinal: Readonly<Record<number, string>>;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
}): ProviderAdapterV2Shape {
  return {
    instanceId: input.instanceId,
    provider: input.provider,
    getCapabilities: () => Effect.succeed(input.capabilities),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          provider: input.provider,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        return {
          instanceId: input.instanceId,
          provider: input.provider,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          rawEvents: Stream.empty,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.provider}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                provider: input.provider,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  provider: input.provider,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  provider: input.provider,
                  providerThreadId: turnInput.providerThread.id,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.provider}:${turnInput.runOrdinal}`,
              );
              const response =
                input.responseByRunOrdinal[turnInput.runOrdinal] ??
                `${input.provider} response for run ${turnInput.runOrdinal}`;
              const providerEvents: ReadonlyArray<ProviderAdapterV2Event> = [
                {
                  type: "provider_turn.updated",
                  provider: input.provider,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      provider: input.provider,
                      nativeId: `native-turn:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.runOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  provider: input.provider,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.provider}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.provider}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  provider: input.provider,
                  providerTurnId,
                  status: "completed",
                },
              ];
              for (const event of providerEvents) {
                yield* PubSub.publish(events, event);
              }
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unimplemented(input.provider, "readThreadSnapshot unused in provider switch test"),
          rollbackThread: () =>
            unimplemented(input.provider, "rollbackThread unused in provider switch test"),
          forkThread: () =>
            unimplemented(input.provider, "forkThread unused in provider switch test"),
        };
      }),
  };
}

const waitForIdle = Effect.fn("ProviderSwitchTest.waitForIdle")(function* () {
  const orchestrator = yield* OrchestratorV2;
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return projection;
    }
    yield* Effect.sleep("5 millis");
  }
  return yield* Effect.die(new Error("Provider switch test timed out waiting for idle"));
});

describe("orchestration v2 provider switching", () => {
  it("switches Codex to Claude and returns to the original Codex thread with handoffs", async () => {
    const cwd = await makeCheckpointWorkspace("provider-switch");
    const capturedTurns = await Effect.runPromise(Ref.make<ReadonlyArray<CapturedTurn>>([]));
    const registryLayer = makeProviderAdapterRegistryLayer([
      makeTestAdapter({
        instanceId: ProviderInstanceId.make("codex"),
        provider: "codex",
        capabilities: CodexProviderCapabilitiesV2,
        modelSelection: CODEX_MODEL_SELECTION,
        responseByRunOrdinal: {
          1: "codex before switch",
          3: "codex after return",
        },
        capturedTurns,
      }),
      makeTestAdapter({
        instanceId: ProviderInstanceId.make("claudeAgent"),
        provider: "claudeAgent",
        capabilities: ClaudeProviderCapabilitiesV2,
        modelSelection: CLAUDE_MODEL_SELECTION,
        responseByRunOrdinal: { 2: "claude switched response" },
        capturedTurns,
      }),
    ]);
    const commands = [
      {
        type: "thread.create",
        commandId: CommandId.make("command:provider-switch:create"),
        threadId,
        projectId,
        title: "Provider switch",
        modelSelection: CODEX_MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      },
      {
        type: "message.dispatch",
        commandId: CommandId.make("command:provider-switch:codex"),
        threadId,
        messageId: MessageId.make("message:provider-switch:codex"),
        text: firstPrompt,
        attachments: [],
        modelSelection: CODEX_MODEL_SELECTION,
        dispatchMode: { type: "start_immediately" },
      },
      {
        type: "message.dispatch",
        commandId: CommandId.make("command:provider-switch:claude"),
        threadId,
        messageId: MessageId.make("message:provider-switch:claude"),
        text: claudePrompt,
        attachments: [],
        modelSelection: CLAUDE_MODEL_SELECTION,
        dispatchMode: { type: "start_immediately" },
      },
      {
        type: "message.dispatch",
        commandId: CommandId.make("command:provider-switch:return"),
        threadId,
        messageId: MessageId.make("message:provider-switch:return"),
        text: returnPrompt,
        attachments: [],
        modelSelection: CODEX_MODEL_SELECTION,
        dispatchMode: { type: "start_immediately" },
      },
    ] satisfies ReadonlyArray<OrchestrationV2Command>;

    try {
      const projection = await Effect.runPromise(
        Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          yield* orchestrator.dispatch(commands[0]!);
          yield* orchestrator.dispatch(commands[1]!);
          yield* waitForIdle();
          yield* orchestrator.dispatch(commands[2]!);
          yield* waitForIdle();
          yield* orchestrator.dispatch(commands[3]!);
          return yield* waitForIdle();
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "provider-switch",
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: {
                    type: "readOnly",
                    access: { type: "fullAccess" },
                    networkAccess: false,
                  },
                },
              },
              registryLayer,
            ),
          ),
        ),
      );
      const turns = await Effect.runPromise(Ref.get(capturedTurns));

      assert.deepEqual(
        projection.runs.map((run) => [run.provider, run.status]),
        [
          ["codex", "completed"],
          ["claudeAgent", "completed"],
          ["codex", "completed"],
        ],
      );
      assert.lengthOf(projection.providerThreads, 2);
      assert.equal(projection.runs[0]?.providerThreadId, projection.runs[2]?.providerThreadId);
      assert.notEqual(projection.runs[0]?.providerThreadId, projection.runs[1]?.providerThreadId);
      assert.deepEqual(
        projection.contextHandoffs.map((handoff) => handoff.strategy),
        ["full_thread_summary", "delta_since_target_last_seen"],
      );
      assert.deepEqual(
        projection.contextTransfers.map((transfer) => [
          transfer.type,
          transfer.status,
          transfer.resolution?.strategy,
        ]),
        [
          ["provider_handoff", "consumed", "portable_context"],
          ["provider_handoff", "consumed", "delta_context"],
        ],
      );
      assert.deepEqual(
        projection.turnItems
          .filter((item) => item.type === "user_message")
          .map((item) => item.text),
        [firstPrompt, claudePrompt, returnPrompt],
      );
      assert.deepEqual(
        projection.providerThreads.map((providerThread) => [
          providerThread.provider,
          providerThread.status,
          providerThread.handoffIds.length,
        ]),
        [
          ["codex", "idle", 1],
          ["claudeAgent", "idle", 1],
        ],
      );
      assert.equal(turns[0]?.text, firstPrompt);
      assert.include(turns[1]?.text ?? "", "Context handoff (full_thread_summary):");
      assert.include(turns[1]?.text ?? "", "codex before switch");
      assert.include(turns[1]?.text ?? "", claudePrompt);
      assert.include(turns[2]?.text ?? "", "Context handoff (delta_since_target_last_seen):");
      assert.include(turns[2]?.text ?? "", "claude switched response");
      assert.include(turns[2]?.text ?? "", returnPrompt);
      assert.notInclude(turns[2]?.text ?? "", "codex before switch");
      assert.equal(turns[0]?.providerThreadId, turns[2]?.providerThreadId);
    } finally {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(cwd, { recursive: true, force: true });
        }).pipe(Effect.provide(NodeServices.layer)),
      );
    }
  });
});
