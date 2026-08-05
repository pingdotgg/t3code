import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpCreatedThread,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  ProviderThreadId,
  ProviderTurnId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { OrchestratorV2, type OrchestratorV2Shape } from "../orchestration-v2/Orchestrator.ts";
import { layer as threadManagementServiceLayer } from "../orchestration-v2/ThreadManagementService.ts";
import {
  type ProviderAdapterV2Event,
  ProviderAdapterProtocolError,
  type ProviderAdapterV2Shape,
  type ProviderAdapterV2TurnInput,
} from "../orchestration-v2/ProviderAdapter.ts";
import { makeLayer as makeProviderAdapterRegistryLayer } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  type ProviderContinuationRequest,
  ProviderContinuationRequests,
} from "../orchestration-v2/ProviderContinuationRequests.ts";
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexModel = "gpt-5.4";
const claudeModel = "claude-sonnet-4-6";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const createdThreadPrompt = "Complete the newly created ordinary thread.";

const decodeCreateThreadsResult = Schema.decodeUnknownEffect(OrchestratorMcpCreateThreadsResult);
const decodeCreatedThread = Schema.decodeUnknownEffect(OrchestratorMcpCreatedThread);
const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeTaskCancelResult = Schema.decodeUnknownEffect(OrchestratorMcpTaskCancelResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadListResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeThreadReadResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeThreadWaitResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const claudeSelection = {
  instanceId: claudeInstanceId,
  model: claudeModel,
} satisfies ModelSelection;

interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
}

function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapterProtocolError({ driver, detail }));
}

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly shouldComplete: (turn: ProviderAdapterV2TurnInput) => boolean;
  readonly terminalGate?: (turn: ProviderAdapterV2TurnInput) => Deferred.Deferred<void> | undefined;
  readonly response: (turn: ProviderAdapterV2TurnInput) => string;
}): ProviderAdapterV2Shape {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const publish = (providerEvents: ReadonlyArray<ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();
        const turnInputs = new Map<ProviderTurnId, ProviderAdapterV2TurnInput>();

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
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
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  instanceId: input.instanceId,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              turnInputs.set(providerTurnId, turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              const terminalGate = input.terminalGate?.(turnInput);
              if (terminalGate !== undefined) {
                yield* Deferred.await(terminalGate);
              } else if (!input.shouldComplete(turnInput)) {
                return;
              }
              const response = input.response(turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
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
                      `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              const turnInput = turnInputs.get(providerTurnId);
              const completedAt = yield* DateTime.now;
              if (turnInput !== undefined) {
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver: input.driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "interrupted",
                      startedAt: completedAt,
                      completedAt,
                    },
                  },
                ]);
              }
              yield* publish([
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unsupported(input.driver, "readThreadSnapshot is unused in this test"),
          rollbackThread: () => unsupported(input.driver, "rollbackThread is unused in this test"),
          forkThread: () => unsupported(input.driver, "forkThread is unused in this test"),
        };
      }),
  };
}

function waitForProjection(
  orchestrator: OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (predicate(projection)) {
        return projection;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(
      new Error(`Timed out waiting for orchestration projection ${threadId}.`),
    );
  });
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

/** Build a persisted-looking ScheduledTask from an upsert input for the in-memory stub. */
function scheduledTaskFromUpsert(input: ScheduledTaskUpsertInput): ScheduledTask {
  const timestamp = IsoDateTime.make("2026-07-01T09:00:00.000Z");
  return {
    id: input.id ?? ScheduledTaskId.make(`scheduled-task:${input.commandId ?? "stub"}`),
    title: input.title,
    prompt: input.prompt,
    enabled: input.enabled,
    schedule: input.schedule,
    projectId: input.projectId,
    threadId: input.threadId ?? null,
    workspaceStrategy: input.workspaceStrategy,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    createdBy: input.createdBy ?? "user",
    creationSource: input.creationSource ?? "web",
    createdAt: timestamp,
    updatedAt: timestamp,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
}

describe("orchestrator MCP toolkit", () => {
  it.live(
    "delegates cross-provider tasks, polls and cancels children, and creates ordinary threads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("orchestrator-mcp-toolkit");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const parentTerminalGates = new Map<ThreadId, Deferred.Deferred<void>>();
          const deliveryTerminalGates = new Map<ThreadId, Deferred.Deferred<void>>();
          const registryLayer = makeProviderAdapterRegistryLayer([
            makeDeterministicAdapter({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              capabilities: CodexProviderCapabilitiesV2,
              capturedTurns,
              shouldComplete: (turn) =>
                turn.threadId !== parentThreadId && turn.message.text !== cancellationPrompt,
              terminalGate: (turn) =>
                turn.message.text.startsWith("Delegated task") ||
                turn.message.text.startsWith("Delegated tasks")
                  ? deliveryTerminalGates.get(turn.threadId)
                  : parentTerminalGates.get(turn.threadId),
              response: (turn) => `Codex completed: ${turn.message.text}`,
            }),
            makeDeterministicAdapter({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              capabilities: ClaudeProviderCapabilitiesV2,
              capturedTurns,
              shouldComplete: (turn) => turn.message.text !== cancellationPrompt,
              terminalGate: (turn) =>
                turn.message.text.startsWith("Delegated task") ||
                turn.message.text.startsWith("Delegated tasks")
                  ? deliveryTerminalGates.get(turn.threadId)
                  : parentTerminalGates.get(turn.threadId),
              response: (turn) =>
                turn.message.text === delegatedPrompt
                  ? delegatedResult
                  : `Claude completed: ${turn.message.text}`,
            }),
          ]);
          // Captures parent-wake offers made when a delegated child
          // terminalizes after the parent run settled.
          const continuationOffers = yield* Ref.make<ReadonlyArray<ProviderContinuationRequest>>(
            [],
          );
          const continuationProbeLayer = Layer.succeed(ProviderContinuationRequests, {
            offer: (request) =>
              Ref.update(continuationOffers, (existing) => [...existing, request]),
            take: Effect.never,
          });
          // Offers land after the finalize projection writes, so poll briefly
          // instead of asserting counts immediately.
          const waitForContinuationOffers = (count: number) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 1_000; attempt += 1) {
                const current = yield* Ref.get(continuationOffers);
                if (current.length >= count) {
                  return current;
                }
                yield* Effect.sleep("5 millis");
              }
              return yield* Ref.get(continuationOffers);
            });
          // Absence has no event to await, so sample repeatedly instead of
          // trusting a single sleep to outlast a late offer.
          const expectOffersToStay = (count: number) =>
            Effect.gen(function* () {
              for (let sample = 0; sample < 4; sample += 1) {
                yield* Effect.sleep("50 millis");
                expect(yield* Ref.get(continuationOffers)).toHaveLength(count);
              }
            });
          const orchestratorLayer = makeOrchestratorV2ReplayLayerWithRegistry(
            {
              name: "orchestrator-mcp-toolkit",
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
          ).pipe(Layer.provide(continuationProbeLayer));
          const orchestrationLayer = Layer.merge(
            orchestratorLayer,
            threadManagementServiceLayer.pipe(Layer.provide(orchestratorLayer)),
          );
          const providerRegistryLayer = makeProviderRegistryLayer([
            makeProviderSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: codexModel,
              optionDescriptors: [
                {
                  id: "reasoning",
                  label: "Reasoning effort",
                  type: "select",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "medium", label: "Medium" },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            }),
            makeProviderSnapshot({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              model: claudeModel,
            }),
            makeProviderSnapshot({
              instanceId: ProviderInstanceId.make("opencode"),
              driver: ProviderDriverKind.make("opencode"),
              model: "opencode/test",
            }),
          ]);
          // In-memory ScheduledTaskService stub so the schedule/list/update/
          // delete tools can be exercised without SQL/launch wiring.
          const scheduledStore = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
          const scheduledTaskStubLayer = Layer.succeed(
            ScheduledTaskService,
            ScheduledTaskService.of({
              list: () => Ref.get(scheduledStore).pipe(Effect.map((tasks) => ({ tasks }))),
              subscribeList: () => Stream.empty,
              upsert: (input) =>
                Effect.gen(function* () {
                  const task = scheduledTaskFromUpsert(input);
                  yield* Ref.update(scheduledStore, (all) => [
                    ...all.filter((candidate) => candidate.id !== task.id),
                    task,
                  ]);
                  return { task };
                }),
              setEnabled: () =>
                Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
              delete: (input) =>
                Ref.update(scheduledStore, (all) =>
                  all.filter((candidate) => candidate.id !== input.id),
                ).pipe(Effect.as({ id: input.id })),
              runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
            }),
          );
          const testLayer = McpHttpServer.OrchestratorToolkitRegistrationLive.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provideMerge(orchestrationLayer),
            Layer.provide(providerRegistryLayer),
            Layer.provide(scheduledTaskStubLayer),
            Layer.provide(NodeServices.layer),
          );

          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const server = yield* McpServer.McpServer;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("message:mcp-parent:start"),
              text: parentPrompt,
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const parent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some((run) =>
                  ["starting", "running", "waiting"].includes(run.status),
                ) && projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const parentRun = parent.runs[0];
            expect(parentRun?.status).toBe("running");

            const invocation: McpInvocationContext.McpInvocationScope = {
              environmentId: EnvironmentId.make("environment:mcp-orchestrator"),
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-parent",
              providerInstanceId: codexInstanceId,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
            };
            const invoke = (name: string, args: Record<string, unknown>) =>
              server
                .callTool({ name, arguments: args })
                .pipe(
                  Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );

            if (parentRun === undefined || parentRun.rootNodeId === null) {
              return yield* Effect.die(new Error("Parent run missing."));
            }
            let parentRootNodeId = parentRun.rootNodeId;
            const queueAutomaticCompletion = (suffix: string, taskText: string) =>
              Effect.gen(function* () {
                const delegated = yield* orchestrator.dispatch({
                  type: "delegated_task.request",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId: CommandId.make(`command:mcp-parent:${suffix}:delegate`),
                  parentThreadId,
                  parentRunId: parentRun.id,
                  parentNodeId: parentRootNodeId,
                  task: taskText,
                  modelSelection: claudeSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  completionWake: "always",
                });
                const taskEvent = delegated.storedEvents.find(
                  (stored) =>
                    stored.event.type === "subagent.updated" &&
                    stored.event.payload.origin === "app_owned",
                );
                if (taskEvent?.event.type !== "subagent.updated") {
                  return yield* Effect.die(
                    new Error(`Automatic completion task ${suffix} was not created.`),
                  );
                }
                const task = taskEvent.event.payload;
                const reserved = yield* waitForProjection(
                  orchestrator,
                  parentThreadId,
                  (projection) => {
                    const delivery = projection.runs.find((run) => run.id === parentRun.id)
                      ?.delegatedCompletion?.delivery;
                    return (
                      projection.subagents.find((candidate) => candidate.id === task.id)?.status ===
                        "completed" &&
                      delivery !== undefined &&
                      delivery !== null &&
                      delivery.taskIds.includes(task.id)
                    );
                  },
                );
                const delivery = reserved.runs.find((run) => run.id === parentRun.id)
                  ?.delegatedCompletion?.delivery;
                if (delivery === undefined || delivery === null) {
                  return yield* Effect.die(
                    new Error(`Automatic completion delivery ${suffix} was not reserved.`),
                  );
                }
                yield* orchestrator.dispatch({
                  type: "message.dispatch",
                  createdBy: "agent",
                  creationSource: "server",
                  commandId: CommandId.make(`command:mcp-parent:${suffix}:dispatch`),
                  threadId: parentThreadId,
                  messageId: delivery.messageId,
                  text: "Delegated task reached a terminal state.",
                  attachments: [],
                  modelSelection: codexSelection,
                  dispatchMode: { type: "queue_after_active" },
                  delegatedCompletion: {
                    parentRunId: parentRun.id,
                    generation: delivery.generation,
                    taskIds: delivery.taskIds,
                  },
                });
                const queued = yield* waitForProjection(
                  orchestrator,
                  parentThreadId,
                  (projection) =>
                    projection.runs.some(
                      (run) => run.userMessageId === delivery.messageId && run.status === "queued",
                    ),
                );
                const queuedRun = queued.runs.find(
                  (run) => run.userMessageId === delivery.messageId,
                );
                if (queuedRun === undefined) {
                  return yield* Effect.die(
                    new Error(`Automatic completion delivery ${suffix} was not queued.`),
                  );
                }
                return { task, delivery, queuedRun };
              });

            // Several async terminals belonging to one parent run reserve one
            // durable delivery. The continuation worker owns the later
            // message.dispatch, so use the same metadata here while the test
            // probe records the offers instead of starting a worker.
            const coalescedTask = (suffix: string) =>
              orchestrator.dispatch({
                type: "delegated_task.request",
                createdBy: "agent",
                creationSource: "mcp",
                commandId: CommandId.make(`command:mcp-parent:coalesced-${suffix}`),
                parentThreadId,
                parentRunId: parentRun.id,
                parentNodeId: parentRootNodeId,
                task: `Complete coalesced task ${suffix}.`,
                modelSelection: claudeSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                completionWake: "always",
              });
            const firstCoalesced = yield* coalescedTask("one");
            const secondCoalesced = yield* coalescedTask("two");
            const coalescedTaskIds = [firstCoalesced, secondCoalesced].map((result) => {
              const taskEvent = result.storedEvents.find(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.origin === "app_owned",
              );
              if (taskEvent?.event.type !== "subagent.updated") {
                throw new Error("Coalesced delegated task projection missing.");
              }
              return taskEvent.event.payload.id;
            });
            const coalescedProjection = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                coalescedTaskIds.every(
                  (taskId) =>
                    projection.subagents.find((task) => task.id === taskId)?.status === "completed",
                ) &&
                projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion !==
                  undefined,
            );
            const coalescedCohort = coalescedProjection.runs.find(
              (run) => run.id === parentRun.id,
            )?.delegatedCompletion;
            expect(coalescedCohort?.delivery?.taskIds).toEqual(
              expect.arrayContaining(coalescedTaskIds),
            );
            expect(coalescedCohort?.delivery?.taskIds).toHaveLength(2);
            const coalescedOffers = yield* waitForContinuationOffers(1);
            expect(coalescedOffers).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  delegatedCompletion: expect.objectContaining({
                    parentRunId: parentRun.id,
                    messageId: coalescedCohort?.delivery?.messageId,
                  }),
                }),
              ]),
            );
            if (coalescedCohort?.delivery === undefined || coalescedCohort.delivery === null) {
              return yield* Effect.die(new Error("Coalesced delivery reservation missing."));
            }
            const coalescedDelivery = coalescedCohort.delivery;
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-parent:dispatch-coalesced-delivery"),
              threadId: parentThreadId,
              messageId: coalescedDelivery.messageId,
              text: "Delegated tasks reached terminal states.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: parentRun.id,
                generation: coalescedDelivery.generation,
                taskIds: coalescedDelivery.taskIds,
              },
            });
            const queuedCoalesced = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === coalescedDelivery.messageId && run.status === "queued",
                ),
            );
            const queuedCoalescedRun = queuedCoalesced.runs.find(
              (run) => run.userMessageId === coalescedDelivery.messageId,
            );
            expect(queuedCoalescedRun?.status).toBe("queued");
            if (queuedCoalescedRun === undefined) {
              return yield* Effect.die(new Error("Queued coalesced delivery missing."));
            }

            // Server-owned delivery ownership is authoritative even if a
            // stale client tries to mutate the queue directly.
            const completionEditError = yield* orchestrator
              .dispatch({
                type: "queued-run.edit",
                commandId: CommandId.make("command:mcp-parent:edit-coalesced-delivery"),
                threadId: parentThreadId,
                runId: queuedCoalescedRun.id,
                text: "Rewrite the automatic delivery.",
              })
              .pipe(Effect.flip);
            expect(completionEditError._tag).toBe("OrchestratorDispatchError");
            const completionReorderError = yield* orchestrator
              .dispatch({
                type: "queued-run.reorder",
                commandId: CommandId.make("command:mcp-parent:reorder-coalesced-delivery"),
                threadId: parentThreadId,
                runId: queuedCoalescedRun.id,
                beforeRunId: null,
              })
              .pipe(Effect.flip);
            expect(completionReorderError._tag).toBe("OrchestratorDispatchError");
            const completionSteerError = yield* orchestrator
              .dispatch({
                type: "queued-message.promote-to-steer",
                commandId: CommandId.make("command:mcp-parent:steer-coalesced-delivery"),
                threadId: parentThreadId,
                queuedRunId: queuedCoalescedRun.id,
                targetRunId: parentRun.id,
              })
              .pipe(Effect.flip);
            expect(completionSteerError._tag).toBe("OrchestratorDispatchError");

            for (const taskId of coalescedTaskIds) {
              const statusCall = yield* invoke("task_status", { taskId });
              expect(statusCall.isError).toBe(false);
            }
            const acknowledgedCoalesced = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === queuedCoalescedRun.id)?.status ===
                  "cancelled" &&
                coalescedTaskIds.every(
                  (taskId) =>
                    projection.subagents.find((task) => task.id === taskId)?.completionDelivery
                      ?.state === "acknowledged",
                ),
            );
            expect(
              acknowledgedCoalesced.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                ?.delivery,
            ).toBeNull();
            yield* Ref.set(continuationOffers, []);

            // Waiting only observes the child run's status. A direct parent
            // read acknowledges delivery only after the terminal result is
            // returned untruncated, never from the child prompt or a partial
            // result page.
            const directRead = yield* queueAutomaticCompletion(
              "direct-child-read",
              "Complete before a parent reads this child result directly.",
            );
            if (directRead.task.childThreadId === null) {
              return yield* Effect.die(new Error("Direct-read child thread missing."));
            }
            const directChildThreadId = directRead.task.childThreadId;
            const directChildWaitCall = yield* invoke("t3_thread_wait", {
              threadId: directChildThreadId,
              timeoutMs: 10_000,
            });
            const directChildWait = yield* decodeThreadWaitResult(
              directChildWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(directChildWait).toMatchObject({
              threadId: directChildThreadId,
              status: "completed",
              timedOut: false,
            });
            const pendingAfterWait = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(
              pendingAfterWait.subagents.find((task) => task.id === directRead.task.id)
                ?.completionDelivery?.state,
            ).toBe("claimed");
            expect(
              pendingAfterWait.runs.find((run) => run.id === directRead.queuedRun.id)?.status,
            ).toBe("queued");

            const childPromptReadCall = yield* invoke("t3_thread_read", {
              threadId: directChildThreadId,
              limit: 1,
            });
            const childPromptRead = yield* decodeThreadReadResult(
              childPromptReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(childPromptRead.items.map((item) => item.type)).toEqual(["user_message"]);
            if (childPromptRead.nextPosition === null) {
              return yield* Effect.die(new Error("Direct-read child prompt position missing."));
            }
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === directRead.task.id,
              )?.completionDelivery?.state,
            ).toBe("claimed");

            const truncatedResultReadCall = yield* invoke("t3_thread_read", {
              threadId: directChildThreadId,
              afterPosition: childPromptRead.nextPosition,
              limit: 1,
              maxCharsPerItem: 1,
            });
            const truncatedResultRead = yield* decodeThreadReadResult(
              truncatedResultReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(truncatedResultRead.items).toMatchObject([
              { type: "assistant_message", textTruncated: true },
            ]);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === directRead.task.id,
              )?.completionDelivery?.state,
            ).toBe("claimed");

            const terminalResultReadCall = yield* invoke("t3_thread_read", {
              threadId: directChildThreadId,
              afterPosition: childPromptRead.nextPosition,
              limit: 1,
            });
            const terminalResultRead = yield* decodeThreadReadResult(
              terminalResultReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(terminalResultRead.items).toMatchObject([
              {
                type: "assistant_message",
                text: "Claude completed: Complete before a parent reads this child result directly.",
                textTruncated: false,
              },
            ]);
            const acknowledgedByDirectRead = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === directRead.queuedRun.id)?.status ===
                  "cancelled" &&
                projection.subagents.find((task) => task.id === directRead.task.id)
                  ?.completionDelivery?.state === "acknowledged",
            );
            expect(
              acknowledgedByDirectRead.subagents.find((task) => task.id === directRead.task.id)
                ?.completionDelivery,
            ).toMatchObject({ state: "acknowledged", observedByRunId: parentRun.id });
            yield* Ref.set(continuationOffers, []);

            // New user work retains its own queue entry while an explicit
            // observation disposes the stale automatic one.
            const queueRace = yield* queueAutomaticCompletion(
              "queue-race",
              "Complete before a user queues follow-up work.",
            );
            const queuedUserMessageId = MessageId.make("message:mcp-parent:queue-race:user");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:queue-race:user"),
              threadId: parentThreadId,
              messageId: queuedUserMessageId,
              text: "Queue user follow-up work.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
            });
            const queueRaceQueued = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some((run) => run.id === queueRace.queuedRun.id) &&
                projection.runs.some(
                  (run) => run.userMessageId === queuedUserMessageId && run.status === "queued",
                ),
            );
            const queuedUserRun = queueRaceQueued.runs.find(
              (run) => run.userMessageId === queuedUserMessageId,
            );
            if (queuedUserRun === undefined) {
              return yield* Effect.die(new Error("Queued user follow-up missing."));
            }
            const queueRaceStatus = yield* invoke("task_status", { taskId: queueRace.task.id });
            expect(queueRaceStatus.isError).toBe(false);
            yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === queueRace.queuedRun.id)?.status ===
                  "cancelled" &&
                projection.runs.find((run) => run.id === queuedUserRun.id)?.status === "queued" &&
                projection.subagents.find((task) => task.id === queueRace.task.id)
                  ?.completionDelivery?.state === "acknowledged",
            );
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("command:mcp-parent:queue-race:cleanup"),
              threadId: parentThreadId,
              runId: queuedUserRun.id,
            });

            // A native in-place Steer keeps the parent active. Once the
            // parent observes the child result, its queued delivery is stale.
            const steerRace = yield* queueAutomaticCompletion(
              "steer-race",
              "Complete before a user steers the parent.",
            );
            const steerMessageId = MessageId.make("message:mcp-parent:steer-race:user");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:steer-race:user"),
              threadId: parentThreadId,
              messageId: steerMessageId,
              text: "Steer the active parent after receiving the result.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "steer_active", targetRunId: parentRun.id },
            });
            const steerRaceStatus = yield* invoke("task_status", { taskId: steerRace.task.id });
            expect(steerRaceStatus.isError).toBe(false);
            const acknowledgedSteerRace = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.messages.some((message) => message.id === steerMessageId) &&
                projection.runs.find((run) => run.id === parentRun.id)?.status === "running" &&
                projection.runs.find((run) => run.id === steerRace.queuedRun.id)?.status ===
                  "cancelled" &&
                projection.subagents.find((task) => task.id === steerRace.task.id)
                  ?.completionDelivery?.state === "acknowledged",
            );
            expect(
              acknowledgedSteerRace.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                ?.delivery,
            ).toBeNull();

            // Restart creates a new attempt for the same parent cohort. The
            // old terminal must not turn that continuation into a Stop
            // barrier, and an acknowledged result cancels the stale delivery.
            const restartRace = yield* queueAutomaticCompletion(
              "restart-race",
              "Complete before a user restarts the parent.",
            );
            const attemptBeforeRestart = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).runs.find((run) => run.id === parentRun.id)?.activeAttemptId;
            const restartMessageId = MessageId.make("message:mcp-parent:restart-race:user");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-parent:restart-race:user"),
              threadId: parentThreadId,
              messageId: restartMessageId,
              text: "Restart the active parent after receiving the result.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "restart_active", targetRunId: parentRun.id },
            });
            const restartedParent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) => {
                const run = projection.runs.find((candidate) => candidate.id === parentRun.id);
                return (
                  run?.status === "running" &&
                  run.activeAttemptId !== attemptBeforeRestart &&
                  run.rootNodeId !== null
                );
              },
            );
            const currentParentRun = restartedParent.runs.find((run) => run.id === parentRun.id);
            if (currentParentRun?.rootNodeId === null || currentParentRun === undefined) {
              return yield* Effect.die(new Error("Restarted parent run missing."));
            }
            parentRootNodeId = currentParentRun.rootNodeId;
            expect(currentParentRun.delegatedCompletion?.disposition).toBe("open");
            const restartRaceStatus = yield* invoke("task_status", {
              taskId: restartRace.task.id,
            });
            expect(restartRaceStatus.isError).toBe(false);
            yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.messages.some((message) => message.id === restartMessageId) &&
                projection.runs.find((run) => run.id === restartRace.queuedRun.id)?.status ===
                  "cancelled" &&
                projection.subagents.find((task) => task.id === restartRace.task.id)
                  ?.completionDelivery?.state === "acknowledged" &&
                projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                  ?.disposition === "open",
            );
            yield* Ref.set(continuationOffers, []);

            const capabilitiesTool = server.tools.find(
              ({ tool }) => tool.name === "orchestrator_capabilities",
            );
            expect(capabilitiesTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(capabilitiesTool?.tool.annotations?.idempotentHint).toBe(true);
            const delegateTool = server.tools.find(({ tool }) => tool.name === "delegate_task");
            expect(delegateTool?.tool.annotations?.destructiveHint).toBe(true);
            expect(delegateTool?.tool.annotations?.openWorldHint).toBe(true);
            const taskStatusTool = server.tools.find(({ tool }) => tool.name === "task_status");
            expect(taskStatusTool?.tool.annotations?.readOnlyHint).toBe(false);
            expect(taskStatusTool?.tool.annotations?.idempotentHint).toBe(true);
            const createThreadsTool = server.tools.find(
              ({ tool }) => tool.name === "create_threads",
            );
            expect(createThreadsTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadListTool = server.tools.find(({ tool }) => tool.name === "t3_thread_list");
            expect(threadListTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(threadListTool?.tool.annotations?.idempotentHint).toBe(true);
            const threadReadTool = server.tools.find(({ tool }) => tool.name === "t3_thread_read");
            expect(threadReadTool?.tool.annotations?.readOnlyHint).toBe(false);
            const threadSendTool = server.tools.find(({ tool }) => tool.name === "t3_thread_send");
            expect(threadSendTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadWaitTool = server.tools.find(({ tool }) => tool.name === "t3_thread_wait");
            expect(threadWaitTool?.tool.annotations?.readOnlyHint).toBe(true);
            const threadInterruptTool = server.tools.find(
              ({ tool }) => tool.name === "t3_thread_interrupt",
            );
            expect(threadInterruptTool?.tool.annotations?.destructiveHint).toBe(true);

            const capabilities = yield* invoke("orchestrator_capabilities", {});
            expect(capabilities.isError).toBe(false);
            expect(capabilities.structuredContent).toMatchObject({
              inheritedProviderInstanceId: codexInstanceId,
              inheritedModel: codexModel,
              features: {
                appOwnedSubagents: true,
                asyncPolling: true,
                cancellation: true,
                batchThreadCreation: true,
                threadManagement: true,
                incrementalThreadRead: true,
              },
              providers: expect.arrayContaining([
                expect.objectContaining({
                  providerInstanceId: claudeInstanceId,
                  canRunCrossProviderChildTask: true,
                }),
                expect.objectContaining({
                  providerInstanceId: "opencode",
                  canRunChildTask: true,
                }),
                // Models advertise their option descriptors so agents can
                // discover valid target.options ids and values.
                expect.objectContaining({
                  providerInstanceId: codexInstanceId,
                  models: [
                    expect.objectContaining({
                      id: codexModel,
                      options: [expect.objectContaining({ id: "reasoning", type: "select" })],
                    }),
                  ],
                }),
              ]),
            });

            const scheduleTool = server.tools.find(({ tool }) => tool.name === "schedule_task");
            expect(scheduleTool?.tool.annotations?.destructiveHint).toBe(true);
            const scheduleCall = yield* invoke("schedule_task", {
              prompt: "wake up in this thread and say hello",
              schedule: { type: "interval", everyMs: 60_000 },
              clientRequestId: "schedule-hello-1",
            });
            expect(scheduleCall.isError).toBe(false);
            expect(scheduleCall.structuredContent).toMatchObject({
              // Defaults to binding the calling thread.
              boundThreadId: parentThreadId,
              projectId,
              enabled: true,
              schedule: { type: "interval", everyMs: 60_000 },
              // Title is derived from the prompt when omitted.
              title: "wake up in this thread and say hello",
            });
            const scheduledTaskId = (scheduleCall.structuredContent as { scheduledTaskId: string })
              .scheduledTaskId;
            const storedAfterCreate = yield* Ref.get(scheduledStore);
            expect(storedAfterCreate).toHaveLength(1);
            expect(storedAfterCreate[0]).toMatchObject({
              threadId: parentThreadId,
              projectId,
              createdBy: "agent",
              creationSource: "mcp",
              // Inherits the parent thread's model selection.
              modelSelection: codexSelection,
            });

            // list_scheduled_tasks returns the task scoped to this project.
            const scheduledListCall = yield* invoke("list_scheduled_tasks", {});
            expect(scheduledListCall.isError).toBe(false);
            expect(scheduledListCall.structuredContent).toMatchObject({
              tasks: [{ scheduledTaskId, boundThreadId: parentThreadId }],
            });

            // update_scheduled_task pauses without deleting.
            const scheduledUpdateCall = yield* invoke("update_scheduled_task", {
              scheduledTaskId,
              enabled: false,
            });
            expect(scheduledUpdateCall.isError).toBe(false);
            expect(scheduledUpdateCall.structuredContent).toMatchObject({
              scheduledTaskId,
              enabled: false,
            });

            // delete_scheduled_task removes it entirely.
            const scheduledDeleteCall = yield* invoke("delete_scheduled_task", { scheduledTaskId });
            expect(scheduledDeleteCall.isError).toBe(false);
            expect(scheduledDeleteCall.structuredContent).toMatchObject({
              scheduledTaskId,
              deleted: true,
            });
            expect(yield* Ref.get(scheduledStore)).toHaveLength(0);

            // OpenCode 1.15 has emitted this exact nested-object-as-JSON-string
            // shape. Decode it at the MCP boundary rather than failing a task
            // the model otherwise specified correctly.
            const serializedScheduleCall = yield* invoke("schedule_task", {
              prompt: "check for new pull requests",
              schedule: '{"type":"interval","everyMs":3600000}',
              clientRequestId: "schedule-opencode-compat-1",
            });
            expect(serializedScheduleCall.isError).toBe(false);
            expect(serializedScheduleCall.structuredContent).toMatchObject({
              schedule: { type: "interval", everyMs: 3_600_000 },
              boundThreadId: parentThreadId,
            });
            const serializedScheduledTaskId = (
              serializedScheduleCall.structuredContent as { scheduledTaskId: string }
            ).scheduledTaskId;
            yield* invoke("delete_scheduled_task", {
              scheduledTaskId: serializedScheduledTaskId,
            });
            expect(yield* Ref.get(scheduledStore)).toHaveLength(0);

            const delegatedCall = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              target: {
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
              mode: "wait",
              timeoutMs: 10_000,
              clientRequestId: "delegate-claude-1",
            });
            expect(delegatedCall.isError).toBe(false);
            const delegated = yield* decodeDelegateTaskResult(delegatedCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(delegated.status).toBe("completed");
            expect(delegated.summary).toBe(delegatedResult);
            expect(delegated.providerInstanceId).toBe(claudeInstanceId);

            const completedParent = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.subagents.some(
                  (task) =>
                    task.id === delegated.taskId &&
                    task.status === "completed" &&
                    task.result === delegatedResult,
                ) &&
                projection.contextTransfers.some(
                  (transfer) =>
                    transfer.type === "subagent_result" &&
                    transfer.sourceThreadId === delegated.childThreadId,
                ),
            );
            const completedTask = completedParent.subagents.find(
              (task) => task.id === delegated.taskId,
            );
            expect(completedTask).toMatchObject({
              origin: "app_owned",
              createdBy: "agent",
              childThreadId: delegated.childThreadId,
              status: "completed",
              result: delegatedResult,
            });
            const child = yield* orchestrator.getThreadProjection(delegated.childThreadId);
            expect(child.thread.lineage).toEqual({
              parentThreadId,
              relationshipToParent: "subagent",
              rootThreadId: parentThreadId,
            });
            expect(child.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(child.thread.modelSelection).toEqual(claudeSelection);
            expect(
              child.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual([delegatedPrompt]);
            expect(
              child.contextTransfers.some(
                (transfer) =>
                  transfer.type === "subagent_spawn" && transfer.sourceThreadId === parentThreadId,
              ),
            ).toBe(true);
            const capturedAfterDelegate = yield* Ref.get(capturedTurns);
            expect(
              capturedAfterDelegate.filter((turn) => turn.threadId === delegated.childThreadId),
            ).toEqual([
              {
                instanceId: claudeInstanceId,
                threadId: delegated.childThreadId,
                text: delegatedPrompt,
              },
            ]);
            expect(
              capturedAfterDelegate.some(
                (turn) =>
                  turn.threadId === delegated.childThreadId && turn.text.includes(parentPrompt),
              ),
            ).toBe(false);

            const delegatedStatusCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatus = yield* decodeDelegateTaskResult(
              delegatedStatusCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatus.status).toBe("completed");
            expect(delegatedStatus.resultContextTransferId).not.toBeNull();

            const childFollowupCall = yield* invoke("t3_thread_send", {
              threadId: delegated.childThreadId,
              message: "Confirm the delegated API boundary remains inspected.",
              clientRequestId: "delegated-child-followup-1",
            });
            const childFollowup = yield* decodeThreadSendResult(
              childFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            const childFollowupWaitCall = yield* invoke("t3_thread_wait", {
              threadId: delegated.childThreadId,
              runId: childFollowup.runId,
              timeoutMs: 10_000,
            });
            const childFollowupWait = yield* decodeThreadWaitResult(
              childFollowupWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(childFollowupWait).toMatchObject({
              runId: childFollowup.runId,
              status: "completed",
              timedOut: false,
            });
            const delegatedStatusAfterFollowupCall = yield* invoke("task_status", {
              taskId: delegated.taskId,
            });
            const delegatedStatusAfterFollowup = yield* decodeDelegateTaskResult(
              delegatedStatusAfterFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(delegatedStatusAfterFollowup).toMatchObject({
              childRunId: delegated.childRunId,
              status: "completed",
              summary: delegatedResult,
            });

            const activeChildFollowupCall = yield* invoke("t3_thread_send", {
              threadId: delegated.childThreadId,
              message: cancellationPrompt,
              clientRequestId: "delegated-child-active-followup-1",
            });
            const activeChildFollowup = yield* decodeThreadSendResult(
              activeChildFollowupCall.structuredContent,
            ).pipe(Effect.orDie);
            yield* waitForProjection(orchestrator, delegated.childThreadId, (projection) =>
              projection.runs.some(
                (run) => run.id === activeChildFollowup.runId && run.status === "running",
              ),
            );
            const completedTaskCancelCall = yield* invoke("task_cancel", {
              taskId: delegated.taskId,
              reason: "Must not interrupt a later unrelated child run.",
              clientRequestId: "cancel-completed-delegated-task-1",
            });
            const completedTaskCancel = yield* decodeTaskCancelResult(
              completedTaskCancelCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(completedTaskCancel).toEqual({
              taskId: delegated.taskId,
              status: "completed",
            });
            expect(
              (yield* orchestrator.getThreadProjection(delegated.childThreadId)).runs.find(
                (run) => run.id === activeChildFollowup.runId,
              )?.status,
            ).toBe("running");
            const activeChildCleanupCall = yield* invoke("t3_thread_interrupt", {
              threadId: delegated.childThreadId,
              runId: activeChildFollowup.runId,
              reason: "Clean up the active follow-up after verifying task cancellation isolation.",
              clientRequestId: "interrupt-delegated-child-followup-1",
            });
            const activeChildCleanup = yield* decodeThreadInterruptResult(
              activeChildCleanupCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(activeChildCleanup).toMatchObject({
              runId: activeChildFollowup.runId,
              status: "interrupt_requested",
            });
            yield* waitForProjection(orchestrator, delegated.childThreadId, (projection) =>
              projection.runs.some(
                (run) => run.id === activeChildFollowup.runId && run.status === "interrupted",
              ),
            );

            // A wait-mode child (completionWake settled_only) that completes
            // while the parent run is live does not offer a wake: the
            // blocking delegate_task call above already returned the result.
            yield* expectOffersToStay(0);

            const repeatedDelegatedCall = yield* invoke("delegate_task", {
              task: delegatedPrompt,
              target: {
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
              mode: "async",
              clientRequestId: "delegate-claude-1",
            });
            const repeatedDelegated = yield* decodeDelegateTaskResult(
              repeatedDelegatedCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedDelegated.taskId).toBe(delegated.taskId);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.filter(
                (task) => task.id === delegated.taskId,
              ),
            ).toHaveLength(1);

            // Options outside the model's advertised descriptors are rejected
            // before any child thread is created.
            const rejectedOptionsCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: { reasoning: "extreme" },
              },
              mode: "async",
              clientRequestId: "delegate-rejected-options-1",
            });
            expect(rejectedOptionsCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining("rejected options"),
            });

            // Duplicate option ids fail fast: downstream consumers disagree on
            // whether the first or last value of a duplicated id wins.
            const duplicateOptionsCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                options: [
                  { id: "reasoning", value: "low" },
                  { id: "reasoning", value: "high" },
                ],
              },
              mode: "async",
              clientRequestId: "delegate-duplicate-options-1",
            });
            expect(duplicateOptionsCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "invalid_request",
              message: expect.stringContaining("more than once"),
            });

            const cancellableCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
                // Shorthand record form; decodes to the canonical array.
                options: { reasoning: "low" },
              },
              mode: "async",
              clientRequestId: "delegate-cancel-1",
            });
            const cancellable = yield* decodeDelegateTaskResult(
              cancellableCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(cancellable.status).toBe("running");
            yield* waitForProjection(orchestrator, cancellable.childThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            // The requested model options reach the child thread's selection.
            const optionedChild = yield* orchestrator.getThreadProjection(
              cancellable.childThreadId,
            );
            expect(optionedChild.thread.modelSelection).toEqual({
              instanceId: codexInstanceId,
              model: codexModel,
              options: [{ id: "reasoning", value: "low" }],
            });
            const cancelCall = yield* invoke("task_cancel", {
              taskId: cancellable.taskId,
              reason: "Parent no longer needs this work.",
              clientRequestId: "cancel-1",
            });
            const cancelResult = yield* decodeTaskCancelResult(cancelCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(cancelResult.status).toBe("cancel_requested");
            yield* waitForProjection(orchestrator, cancellable.childThreadId, (projection) =>
              projection.runs.some((run) => run.status === "interrupted"),
            );
            const cancelledStatusCall = yield* invoke("task_status", {
              taskId: cancellable.taskId,
            });
            const cancelledStatus = yield* decodeDelegateTaskResult(
              cancelledStatusCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(cancelledStatus.status).toBe("interrupted");

            // Explicit task_cancel disposes automatic delivery after the child
            // interrupt succeeds. The interrupted result remains readable,
            // but it cannot create a parent continuation.
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === cancellable.taskId,
              )?.completionDelivery,
            ).toMatchObject({ state: "disposed" });
            yield* expectOffersToStay(0);

            const createInput = {
              clientRequestId: "create-thread-batch-1",
              threads: [
                {
                  title: "Inherited empty thread",
                },
                {
                  title: "Claude ordinary thread",
                  prompt: createdThreadPrompt,
                  target: {
                    driverKind: "claudeAgent",
                  },
                },
              ],
            };
            const createCall = yield* invoke("create_threads", createInput);
            expect(createCall.isError).toBe(false);
            const created = yield* decodeCreateThreadsResult(createCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(created.threads).toHaveLength(2);
            const emptyThread = created.threads[0]!;
            const promptedThread = created.threads[1]!;
            expect(emptyThread).toMatchObject({
              status: "idle",
              createdBy: "agent",
              creationSource: "mcp",
              providerInstanceId: codexInstanceId,
              model: codexModel,
            });
            expect(promptedThread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
              providerInstanceId: claudeInstanceId,
              model: claudeModel,
            });
            const emptyProjection = yield* orchestrator.getThreadProjection(emptyThread.threadId);
            expect(emptyProjection.thread.lineage).toEqual({
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: emptyThread.threadId,
            });
            expect(emptyProjection.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(emptyProjection.thread.forkedFrom).toBeNull();
            expect(emptyProjection.runs).toEqual([]);
            const promptedProjection = yield* waitForProjection(
              orchestrator,
              promptedThread.threadId,
              (projection) => projection.runs.some((run) => run.status === "completed"),
            );
            expect(promptedProjection.thread.lineage.parentThreadId).toBeNull();
            expect(
              promptedProjection.messages
                .filter((message) => message.role === "user")
                .map((message) => message.text),
            ).toEqual([createdThreadPrompt]);
            const createdThreadItems = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).visibleTurnItems
              .map((row) => row.item)
              .filter((item) => item.type === "thread_created");
            expect(
              createdThreadItems.map((item) => ({
                targetThreadId: item.targetThreadId,
                targetRunId: item.targetRunId,
                title: item.title,
                providerInstanceId: item.targetProviderInstanceId,
                model: item.targetModel,
              })),
            ).toEqual([
              {
                targetThreadId: emptyThread.threadId,
                targetRunId: null,
                title: emptyThread.title,
                providerInstanceId: codexInstanceId,
                model: codexModel,
              },
              {
                targetThreadId: promptedThread.threadId,
                targetRunId: promptedThread.runId,
                title: promptedThread.title,
                providerInstanceId: claudeInstanceId,
                model: claudeModel,
              },
            ]);

            const repeatedCreateCall = yield* invoke("create_threads", createInput);
            const repeatedCreated = yield* decodeCreateThreadsResult(
              repeatedCreateCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedCreated.threads.map((thread) => thread.threadId)).toEqual(
              created.threads.map((thread) => thread.threadId),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).visibleTurnItems.filter(
                (row) => {
                  if (row.item.type !== "thread_created") return false;
                  const targetThreadId = row.item.targetThreadId;
                  return created.threads.some((thread) => thread.threadId === targetThreadId);
                },
              ),
            ).toHaveLength(2);

            const promptedReadCall = yield* invoke("t3_thread_read", {
              threadId: promptedThread.threadId,
              limit: 1,
            });
            const promptedRead = yield* decodeThreadReadResult(
              promptedReadCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(promptedRead.thread.status).toBe("completed");
            expect(promptedRead.thread).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(promptedRead.items.map((item) => item.type)).toEqual(["user_message"]);
            expect(promptedRead.items[0]).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(promptedRead.hasMore).toBe(true);
            const promptedReadNextCall = yield* invoke("t3_thread_read", {
              threadId: promptedThread.threadId,
              afterPosition: promptedRead.nextPosition,
              limit: 1,
            });
            const promptedReadNext = yield* decodeThreadReadResult(
              promptedReadNextCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(promptedReadNext.items.map((item) => item.type)).toEqual(["assistant_message"]);
            expect(promptedReadNext.items[0]?.text).toBe(
              `Claude completed: ${createdThreadPrompt}`,
            );

            const forkedThreadId = ThreadId.make("thread:mcp-orchestrator-inherited-read");
            yield* orchestrator.dispatch({
              type: "thread.fork",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-orchestrator-inherited-read"),
              sourceThreadId: promptedThread.threadId,
              targetThreadId: forkedThreadId,
              sourcePoint: { type: "latest_stable" },
              title: "Inherited read thread",
            });
            const forkedProjection = yield* orchestrator.getThreadProjection(forkedThreadId);
            expect(forkedProjection.messages).toEqual([]);
            expect(
              forkedProjection.visibleTurnItems.some(
                (row) =>
                  row.sourceThreadId === promptedThread.threadId &&
                  row.item.type === "user_message",
              ),
            ).toBe(true);

            const forkedReadCall = yield* invoke("t3_thread_read", {
              threadId: forkedThreadId,
            });
            const forkedRead = yield* decodeThreadReadResult(forkedReadCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(
              forkedRead.items.find((item) => item.text === createdThreadPrompt),
            ).toMatchObject({
              sourceThreadId: promptedThread.threadId,
              createdBy: "agent",
              creationSource: "mcp",
            });

            const ordinaryLoopPrompt = "Run an ordinary thread loop iteration.";
            const sendCall = yield* invoke("t3_thread_send", {
              threadId: emptyThread.threadId,
              message: ordinaryLoopPrompt,
              clientRequestId: "ordinary-loop-send-1",
            });
            const sent = yield* decodeThreadSendResult(sendCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(sent.delivery).toBe("started");
            const waitCall = yield* invoke("t3_thread_wait", {
              threadId: emptyThread.threadId,
              runId: sent.runId,
              timeoutMs: 10_000,
            });
            const waited = yield* decodeThreadWaitResult(waitCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(waited).toMatchObject({
              runId: sent.runId,
              status: "completed",
              timedOut: false,
            });
            const repeatedSendCall = yield* invoke("t3_thread_send", {
              threadId: emptyThread.threadId,
              message: ordinaryLoopPrompt,
              clientRequestId: "ordinary-loop-send-1",
            });
            const repeatedSend = yield* decodeThreadSendResult(
              repeatedSendCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedSend.runId).toBe(sent.runId);
            expect(
              (yield* orchestrator.getThreadProjection(emptyThread.threadId)).runs,
            ).toHaveLength(1);

            const activeThreadCall = yield* invoke("t3_thread_start", {
              prompt: cancellationPrompt,
              title: "Managed active thread",
              clientRequestId: "managed-active-thread-1",
            });
            const activeThread = yield* decodeCreatedThread(
              activeThreadCall.structuredContent,
            ).pipe(Effect.orDie);
            const activeThreadItem = (yield* orchestrator.getThreadProjection(
              parentThreadId,
            )).visibleTurnItems
              .map((row) => row.item)
              .find(
                (item) =>
                  item.type === "thread_created" && item.targetThreadId === activeThread.threadId,
              );
            expect(activeThreadItem).toMatchObject({
              type: "thread_created",
              title: "Managed active thread",
              targetThreadId: activeThread.threadId,
              targetRunId: activeThread.runId,
              targetProviderInstanceId: codexInstanceId,
              targetModel: codexModel,
            });
            const activeProjection = yield* waitForProjection(
              orchestrator,
              activeThread.threadId,
              (projection) =>
                projection.runs.some((run) => run.status === "running") &&
                projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const activeRun = activeProjection.runs[0]!;
            const activeTimeoutCall = yield* invoke("t3_thread_wait", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
              timeoutMs: 1,
            });
            const activeTimeout = yield* decodeThreadWaitResult(
              activeTimeoutCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(activeTimeout).toMatchObject({
              runId: activeRun.id,
              status: "running",
              timedOut: true,
            });
            const steerCall = yield* invoke("t3_thread_send", {
              threadId: activeThread.threadId,
              message: "Include the latest parent guidance before finishing.",
              mode: "steer",
              clientRequestId: "managed-active-steer-1",
            });
            const steered = yield* decodeThreadSendResult(steerCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(steered).toMatchObject({
              runId: activeRun.id,
              delivery: "steered",
            });
            const interruptCall = yield* invoke("t3_thread_interrupt", {
              threadId: activeThread.threadId,
              reason: "The orchestration loop has enough evidence.",
              clientRequestId: "managed-active-interrupt-1",
            });
            const interrupted = yield* decodeThreadInterruptResult(
              interruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(interrupted).toMatchObject({
              runId: activeRun.id,
              status: "interrupt_requested",
            });
            const interruptedWaitCall = yield* invoke("t3_thread_wait", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
              timeoutMs: 10_000,
            });
            const interruptedWait = yield* decodeThreadWaitResult(
              interruptedWaitCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(interruptedWait.status).toBe("interrupted");
            const repeatedInterruptCall = yield* invoke("t3_thread_interrupt", {
              threadId: activeThread.threadId,
              runId: activeRun.id,
            });
            const repeatedInterrupt = yield* decodeThreadInterruptResult(
              repeatedInterruptCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(repeatedInterrupt.status).toBe("interrupted");

            const foreignThreadId = ThreadId.make("thread:mcp-foreign-project");
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-foreign-project:create"),
              threadId: foreignThreadId,
              projectId: ProjectId.make("project:mcp-foreign"),
              title: "Foreign project thread",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            const foreignReadCall = yield* invoke("t3_thread_read", {
              threadId: foreignThreadId,
            });
            expect(foreignReadCall.structuredContent).toMatchObject({
              _tag: "OrchestratorMcpFailure",
              code: "thread_not_found",
            });
            const listCall = yield* invoke("t3_thread_list", {
              includeSubagents: false,
              limit: 100,
            });
            const listed = yield* decodeThreadListResult(listCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(listed.projectId).toBe(projectId);
            expect(listed.threads.map((thread) => thread.threadId)).toEqual(
              expect.arrayContaining([
                parentThreadId,
                emptyThread.threadId,
                promptedThread.threadId,
                activeThread.threadId,
              ]),
            );
            expect(
              listed.threads.find((thread) => thread.threadId === emptyThread.threadId),
            ).toMatchObject({
              createdBy: "agent",
              creationSource: "mcp",
            });
            expect(listed.threads.some((thread) => thread.threadId === foreignThreadId)).toBe(
              false,
            );
            expect(
              listed.threads.some((thread) => thread.relationshipToParent === "subagent"),
            ).toBe(false);

            // A wait-mode delegation whose blocking wait times out no longer
            // owns delivery, so delegate_task upgrades the task to "always".
            // Its terminal then wakes the parent even mid-turn.
            const upgradedCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
              },
              mode: "wait",
              timeoutMs: 1,
              clientRequestId: "delegate-wait-upgrade-1",
            });
            const upgradedDelegated = yield* decodeDelegateTaskResult(
              upgradedCall.structuredContent,
            ).pipe(Effect.orDie);
            expect(upgradedDelegated.status).toBe("running");
            yield* waitForProjection(orchestrator, upgradedDelegated.childThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === upgradedDelegated.taskId,
              )?.completionWake,
            ).toBe("always");
            const upgradeCancelCall = yield* invoke("task_cancel", {
              taskId: upgradedDelegated.taskId,
              reason: "Terminalize while the parent run is live.",
              clientRequestId: "cancel-wait-upgrade-1",
            });
            expect(upgradeCancelCall.isError).toBe(false);
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) => task.id === upgradedDelegated.taskId && task.status === "interrupted",
              ),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === upgradedDelegated.taskId,
              )?.completionDelivery,
            ).toMatchObject({ state: "disposed" });
            yield* expectOffersToStay(0);

            // The MCP tool cannot force the reverse interleaving (child
            // terminal before the upgrade lands), so dispatch the command
            // directly. The first wait-mode delegation completed while the
            // parent run was live, so finalize skipped its offer under
            // settled_only; the upgrade must accept, persist the policy, and
            // deliver the wake finalize declined.
            const terminalUpgrade = yield* orchestrator.dispatch({
              type: "delegated_task.wake-policy",
              commandId: CommandId.make("command:mcp-parent:wake-policy-terminal"),
              parentThreadId,
              taskId: delegated.taskId,
              completionWake: "always",
            });
            expect(
              terminalUpgrade.storedEvents.some(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === delegated.taskId &&
                  stored.event.payload.completionWake === "always",
              ),
            ).toBe(true);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === delegated.taskId,
              )?.completionWake,
            ).toBe("always");
            // task_status above acknowledged this terminal result, so making
            // its policy eager later cannot re-arm a stale parent wake.
            yield* expectOffersToStay(0);

            // Legacy records omit completionWake and stay settled_only. The
            // MCP service always sets the field now, so dispatch the request
            // directly to cover the legacy shape.
            const legacyDispatch = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-parent:delegate-legacy"),
              parentThreadId,
              parentRunId: parentRun.id,
              parentNodeId: parentRootNodeId,
              task: cancellationPrompt,
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
            });
            const legacyTaskEvent = legacyDispatch.storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (legacyTaskEvent?.event.type !== "subagent.updated") {
              return yield* Effect.die(new Error("Legacy delegated task projection missing."));
            }
            const legacyTask = legacyTaskEvent.event.payload;
            expect(legacyTask.completionWake).toBeUndefined();
            if (legacyTask.childThreadId === null) {
              return yield* Effect.die(new Error("Legacy delegated task child thread missing."));
            }
            const legacyChildThreadId = legacyTask.childThreadId;
            yield* waitForProjection(orchestrator, legacyChildThreadId, (projection) =>
              projection.providerTurns.some((turn) => turn.status === "running"),
            );
            // Nothing terminalized here, so the offer count must hold.
            yield* expectOffersToStay(0);

            // Stop cancels a queued server-owned delivery for this cohort and
            // records a barrier before any still-running child reaches a
            // terminal state.
            const stopQueuedDispatch = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-parent:stop-queued-delivery"),
              parentThreadId,
              parentRunId: parentRun.id,
              parentNodeId: parentRootNodeId,
              task: "Complete the stop barrier delivery task.",
              modelSelection: claudeSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const stopQueuedTaskEvent = stopQueuedDispatch.storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (stopQueuedTaskEvent?.event.type !== "subagent.updated") {
              return yield* Effect.die(
                new Error("Stop barrier delegated task projection missing."),
              );
            }
            const stopQueuedTaskId = stopQueuedTaskEvent.event.payload.id;
            const stopQueuedProjection = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === stopQueuedTaskId)?.status ===
                  "completed" &&
                projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                  ?.delivery !== null &&
                projection.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion
                  ?.delivery !== undefined,
            );
            const stopQueuedDelivery = stopQueuedProjection.runs.find(
              (run) => run.id === parentRun.id,
            )?.delegatedCompletion?.delivery;
            if (stopQueuedDelivery === undefined || stopQueuedDelivery === null) {
              return yield* Effect.die(new Error("Stop barrier delivery reservation missing."));
            }
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-parent:dispatch-stop-queued-delivery"),
              threadId: parentThreadId,
              messageId: stopQueuedDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: parentRun.id,
                generation: stopQueuedDelivery.generation,
                taskIds: stopQueuedDelivery.taskIds,
              },
            });
            const queuedStopDelivery = yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === stopQueuedDelivery.messageId && run.status === "queued",
                ),
            );
            const queuedStopDeliveryRun = queuedStopDelivery.runs.find(
              (run) => run.userMessageId === stopQueuedDelivery.messageId,
            );
            if (queuedStopDeliveryRun === undefined) {
              return yield* Effect.die(new Error("Queued stop barrier delivery missing."));
            }
            yield* Ref.set(continuationOffers, []);

            const parentStop = yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-parent:interrupt-wake"),
              threadId: parentThreadId,
              runId: parentRun.id,
              reason: "Settle the parent before the legacy child terminalizes.",
            });
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.runs.every(
                (run) =>
                  run.status !== "preparing" &&
                  run.status !== "starting" &&
                  run.status !== "running",
              ),
            );
            const stoppedParent = yield* orchestrator.getThreadProjection(parentThreadId);
            expect(stoppedParent.runs.some((run) => run.id === parentRun.id)).toBe(true);
            expect(
              parentStop.storedEvents.some(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === parentRun.id &&
                  stored.event.payload.delegatedCompletion?.disposition === "stopped",
              ),
            ).toBe(true);
            expect(
              stoppedParent.runs.find((run) => run.id === parentRun.id)?.delegatedCompletion,
            ).toMatchObject({ disposition: "stopped", delivery: null });
            expect(
              stoppedParent.runs.find((run) => run.id === queuedStopDeliveryRun.id)?.status,
            ).toBe("cancelled");
            expect(
              stoppedParent.subagents.find((task) => task.id === legacyTask.id)?.completionDelivery,
            ).toMatchObject({ state: "disposed" });
            const legacyChildRun = (yield* orchestrator.getThreadProjection(
              legacyChildThreadId,
            )).runs.find((run) => run.status === "running");
            if (legacyChildRun === undefined) {
              return yield* Effect.die(
                new Error("Still-running child was missing after parent Stop."),
              );
            }
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-parent:interrupt-legacy-after-parent-stop"),
              threadId: legacyChildThreadId,
              runId: legacyChildRun.id,
              reason: "Terminalize after the parent Stop barrier.",
            });
            yield* waitForProjection(orchestrator, legacyChildThreadId, (projection) =>
              projection.runs.some((run) => run.status === "interrupted"),
            );
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === legacyTask.id,
              )?.completionDelivery,
            ).toMatchObject({ state: "disposed" });
            yield* expectOffersToStay(0);

            // Same command against a terminal task whose finalize already
            // offered (the parent was settled then, and still is): the policy
            // must persist without a second offer, or the parent wakes twice.
            const settledUpgrade = yield* orchestrator.dispatch({
              type: "delegated_task.wake-policy",
              commandId: CommandId.make("command:mcp-parent:wake-policy-settled"),
              parentThreadId,
              taskId: legacyTask.id,
              completionWake: "always",
            });
            expect(
              settledUpgrade.storedEvents.some(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === legacyTask.id &&
                  stored.event.payload.completionWake === "always",
              ),
            ).toBe(true);
            expect(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === legacyTask.id,
              )?.completionWake,
            ).toBe("always");
            yield* expectOffersToStay(0);

            // A child that terminalizes after the coalesced delivery started
            // is held for one successor. It must not fan out into a second
            // concurrent delivery for the same parent run.
            const lateParentThreadId = ThreadId.make("thread:mcp-late-completion-parent");
            const lateParentGate = yield* Deferred.make<void>();
            const lateDeliveryGate = yield* Deferred.make<void>();
            parentTerminalGates.set(lateParentThreadId, lateParentGate);
            deliveryTerminalGates.set(lateParentThreadId, lateDeliveryGate);
            yield* Ref.set(continuationOffers, []);
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-late-parent:create"),
              threadId: lateParentThreadId,
              projectId,
              title: "Late completion parent",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-late-parent:start"),
              threadId: lateParentThreadId,
              messageId: MessageId.make("message:mcp-late-parent:start"),
              text: "Hold this parent until its completion delivery is queued.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const lateParentProjection = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some((run) => run.status === "running") &&
                projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const lateParentRun = lateParentProjection.runs.find((run) => run.status === "running");
            if (lateParentRun?.rootNodeId === null || lateParentRun === undefined) {
              return yield* Effect.die(new Error("Late completion parent run missing."));
            }
            const earlyLateDelivery = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-late-parent:early-task"),
              parentThreadId: lateParentThreadId,
              parentRunId: lateParentRun.id,
              parentNodeId: lateParentRun.rootNodeId,
              task: "Complete before the first delivery starts.",
              modelSelection: claudeSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const lateChild = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-late-parent:late-task"),
              parentThreadId: lateParentThreadId,
              parentRunId: lateParentRun.id,
              parentNodeId: lateParentRun.rootNodeId,
              task: cancellationPrompt,
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const taskFromDispatch = (result: typeof earlyLateDelivery) => {
              const taskEvent = result.storedEvents.find(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.origin === "app_owned",
              );
              if (taskEvent?.event.type !== "subagent.updated") {
                throw new Error("Late completion delegated task projection missing.");
              }
              return taskEvent.event.payload;
            };
            const earlyLateTask = taskFromDispatch(earlyLateDelivery);
            const lateTask = taskFromDispatch(lateChild);
            const thirdLateChild = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-late-parent:third-late-task"),
              parentThreadId: lateParentThreadId,
              parentRunId: lateParentRun.id,
              parentNodeId: lateParentRun.rootNodeId,
              task: cancellationPrompt,
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const thirdLateTask = taskFromDispatch(thirdLateChild);
            if (lateTask.childThreadId === null || thirdLateTask.childThreadId === null) {
              return yield* Effect.die(new Error("Late completion child thread missing."));
            }
            const beforeFirstDelivery = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === earlyLateTask.id)?.status ===
                  "completed" &&
                projection.subagents.find((task) => task.id === lateTask.id)?.status ===
                  "running" &&
                projection.runs.find((run) => run.id === lateParentRun.id)?.delegatedCompletion
                  ?.delivery !== null &&
                projection.runs.find((run) => run.id === lateParentRun.id)?.delegatedCompletion
                  ?.delivery !== undefined,
            );
            const firstLateDelivery = beforeFirstDelivery.runs.find(
              (run) => run.id === lateParentRun.id,
            )?.delegatedCompletion?.delivery;
            if (firstLateDelivery === undefined || firstLateDelivery === null) {
              return yield* Effect.die(new Error("First late completion delivery missing."));
            }
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-late-parent:dispatch-first-delivery"),
              threadId: lateParentThreadId,
              messageId: firstLateDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: lateParentRun.id,
                generation: firstLateDelivery.generation,
                taskIds: firstLateDelivery.taskIds,
              },
            });
            yield* Deferred.succeed(lateParentGate, undefined);
            const activeFirstDelivery = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === firstLateDelivery.messageId && run.status === "running",
                ),
            );
            const activeFirstDeliveryRun = activeFirstDelivery.runs.find(
              (run) => run.userMessageId === firstLateDelivery.messageId,
            );
            if (activeFirstDeliveryRun === undefined) {
              return yield* Effect.die(new Error("First late completion delivery did not start."));
            }
            const lateChildProjection = yield* orchestrator.getThreadProjection(
              lateTask.childThreadId,
            );
            const lateChildRun = lateChildProjection.runs[0];
            if (lateChildRun === undefined) {
              return yield* Effect.die(new Error("Late completion child run missing."));
            }
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-late-parent:interrupt-late-child"),
              threadId: lateTask.childThreadId,
              runId: lateChildRun.id,
              reason: "Terminalize after the first completion delivery started.",
            });
            yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === lateTask.id)?.completionDelivery
                  ?.state === "pending",
            );
            yield* Deferred.succeed(lateDeliveryGate, undefined);
            const successorReserved = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) => {
                const delivery = projection.runs.find((run) => run.id === lateParentRun.id)
                  ?.delegatedCompletion?.delivery;
                return (
                  delivery !== undefined &&
                  delivery !== null &&
                  delivery.generation === firstLateDelivery.generation + 1 &&
                  delivery.taskIds.length === 1 &&
                  delivery.taskIds[0] === lateTask.id
                );
              },
            );
            const successorDelivery = successorReserved.runs.find(
              (run) => run.id === lateParentRun.id,
            )?.delegatedCompletion?.delivery;
            expect(successorDelivery).toMatchObject({
              generation: firstLateDelivery.generation + 1,
              taskIds: [lateTask.id],
            });
            const lateOffers = yield* waitForContinuationOffers(2);
            expect(lateOffers).toHaveLength(2);
            expect(
              successorReserved.runs.filter((run) => {
                const message = successorReserved.messages.find(
                  (candidate) => candidate.id === run.userMessageId,
                );
                return message?.delegatedCompletion?.parentRunId === lateParentRun.id;
              }),
            ).toHaveLength(1);
            if (successorDelivery === undefined || successorDelivery === null) {
              return yield* Effect.die(new Error("Late completion successor delivery missing."));
            }

            // The bounded successor can coalesce a late result only once. A
            // third terminal after that successor has started remains
            // inspectable, but cannot recursively create a third parent run.
            const successorGate = yield* Deferred.make<void>();
            deliveryTerminalGates.set(lateParentThreadId, successorGate);
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-late-parent:dispatch-successor-delivery"),
              threadId: lateParentThreadId,
              messageId: successorDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: lateParentRun.id,
                generation: successorDelivery.generation,
                taskIds: successorDelivery.taskIds,
              },
            });
            const activeSuccessor = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === successorDelivery.messageId && run.status === "running",
                ),
            );
            const activeSuccessorRun = activeSuccessor.runs.find(
              (run) => run.userMessageId === successorDelivery.messageId,
            );
            if (activeSuccessorRun === undefined) {
              return yield* Effect.die(new Error("Late completion successor did not start."));
            }
            const thirdLateChildProjection = yield* waitForProjection(
              orchestrator,
              thirdLateTask.childThreadId,
              (projection) =>
                projection.runs.some((run) => run.status === "running") &&
                projection.providerTurns.some((turn) => turn.status === "running"),
            );
            const thirdLateChildRun = thirdLateChildProjection.runs.find(
              (run) => run.status === "running",
            );
            if (thirdLateChildRun === undefined) {
              return yield* Effect.die(new Error("Third late completion child run missing."));
            }
            yield* orchestrator.dispatch({
              type: "run.interrupt",
              commandId: CommandId.make("command:mcp-late-parent:interrupt-third-late-child"),
              threadId: thirdLateTask.childThreadId,
              runId: thirdLateChildRun.id,
              reason: "Terminalize after the bounded successor started.",
            });
            yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === thirdLateTask.id)
                  ?.completionDelivery?.state === "pending",
            );
            yield* Deferred.succeed(successorGate, undefined);
            const exhaustedCohort = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) => {
                const cohort = projection.runs.find(
                  (run) => run.id === lateParentRun.id,
                )?.delegatedCompletion;
                return (
                  cohort?.settledDeliveryCount === 2 &&
                  cohort.delivery === null &&
                  projection.runs.find((run) => run.id === activeSuccessorRun.id)?.status ===
                    "completed" &&
                  projection.subagents.find((task) => task.id === thirdLateTask.id)
                    ?.completionDelivery?.state === "pending"
                );
              },
            );
            expect(
              exhaustedCohort.runs.find((run) => run.id === lateParentRun.id)?.delegatedCompletion,
            ).toMatchObject({ settledDeliveryCount: 2, delivery: null });
            yield* expectOffersToStay(2);

            // Queue Remove is a durable disposal action, not a local queue
            // edit. Start a fresh parent-run cohort so removing this delivery
            // cannot interfere with the bounded late-delivery assertions.
            const removeParentGate = yield* Deferred.make<void>();
            parentTerminalGates.set(lateParentThreadId, removeParentGate);
            const removeParentMessageId = MessageId.make("message:mcp-late-parent:remove-start");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:mcp-late-parent:remove-start"),
              threadId: lateParentThreadId,
              messageId: removeParentMessageId,
              text: "Keep the parent active while removing automatic delivery.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            const removeParentProjection = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) => run.userMessageId === removeParentMessageId && run.status === "running",
                ),
            );
            const removeParentRun = removeParentProjection.runs.find(
              (run) => run.userMessageId === removeParentMessageId,
            );
            if (removeParentRun?.rootNodeId === null || removeParentRun === undefined) {
              return yield* Effect.die(new Error("Queue Remove parent run missing."));
            }
            const removeDelegation = yield* orchestrator.dispatch({
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:mcp-late-parent:remove-delegate"),
              parentThreadId: lateParentThreadId,
              parentRunId: removeParentRun.id,
              parentNodeId: removeParentRun.rootNodeId,
              task: "Complete before Queue Remove disposes this automatic delivery.",
              modelSelection: claudeSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
            });
            const removeTaskEvent = removeDelegation.storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (removeTaskEvent?.event.type !== "subagent.updated") {
              return yield* Effect.die(
                new Error("Queue Remove delegated task projection missing."),
              );
            }
            const removeTask = removeTaskEvent.event.payload;
            const removeReserved = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.subagents.find((task) => task.id === removeTask.id)?.status ===
                  "completed" &&
                projection.runs.find((run) => run.id === removeParentRun.id)?.delegatedCompletion
                  ?.delivery !== null &&
                projection.runs.find((run) => run.id === removeParentRun.id)?.delegatedCompletion
                  ?.delivery !== undefined,
            );
            const removeDelivery = removeReserved.runs.find((run) => run.id === removeParentRun.id)
              ?.delegatedCompletion?.delivery;
            if (removeDelivery === undefined || removeDelivery === null) {
              return yield* Effect.die(new Error("Queue Remove delivery reservation missing."));
            }
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:mcp-late-parent:remove-dispatch"),
              threadId: lateParentThreadId,
              messageId: removeDelivery.messageId,
              text: "Delegated task reached a terminal state.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "queue_after_active" },
              delegatedCompletion: {
                parentRunId: removeParentRun.id,
                generation: removeDelivery.generation,
                taskIds: removeDelivery.taskIds,
              },
            });
            const removeQueued = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.some(
                  (run) =>
                    run.userMessageId === removeDelivery.messageId && run.status === "queued",
                ),
            );
            const removeQueuedRun = removeQueued.runs.find(
              (run) => run.userMessageId === removeDelivery.messageId,
            );
            if (removeQueuedRun === undefined) {
              return yield* Effect.die(new Error("Queue Remove delivery did not queue."));
            }
            yield* Ref.set(continuationOffers, []);
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("command:mcp-late-parent:remove-queued-delivery"),
              threadId: lateParentThreadId,
              runId: removeQueuedRun.id,
            });
            const removedDelivery = yield* waitForProjection(
              orchestrator,
              lateParentThreadId,
              (projection) =>
                projection.runs.find((run) => run.id === removeParentRun.id)?.delegatedCompletion
                  ?.disposition === "disposed" &&
                projection.runs.find((run) => run.id === removeQueuedRun.id)?.status ===
                  "cancelled" &&
                projection.subagents.find((task) => task.id === removeTask.id)?.completionDelivery
                  ?.state === "disposed",
            );
            expect(
              removedDelivery.runs.find((run) => run.id === removeParentRun.id)
                ?.delegatedCompletion,
            ).toMatchObject({ disposition: "disposed", delivery: null });
            expect(
              removedDelivery.subagents.find((task) => task.id === removeTask.id),
            ).toMatchObject({ result: expect.any(String), status: "completed" });
            yield* expectOffersToStay(0);
          }).pipe(Effect.provide(testLayer));
        }),
      ),
  );
});
