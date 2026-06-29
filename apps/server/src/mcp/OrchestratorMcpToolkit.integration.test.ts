import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
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
  ProviderThreadId,
  ProviderTurnId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
import { checkpointWorkspace } from "../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
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
        capabilities: null,
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
              if (!input.shouldComplete(turnInput)) {
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
            PubSub.publish(events, {
              type: "turn.terminal",
              driver: input.driver,
              providerThreadId: providerThread.id,
              providerTurnId,
              runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
              status: "interrupted",
              failure: null,
              threadDisposition: "reusable",
            }).pipe(Effect.asVoid),
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
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

describe("orchestrator MCP toolkit", () => {
  it.live(
    "delegates cross-provider tasks, polls and cancels children, and creates ordinary threads",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("orchestrator-mcp-toolkit");
          const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
          const registryLayer = makeProviderAdapterRegistryLayer([
            makeDeterministicAdapter({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              capabilities: CodexProviderCapabilitiesV2,
              capturedTurns,
              shouldComplete: (turn) =>
                turn.threadId !== parentThreadId && turn.message.text !== cancellationPrompt,
              response: (turn) => `Codex completed: ${turn.message.text}`,
            }),
            makeDeterministicAdapter({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              capabilities: ClaudeProviderCapabilitiesV2,
              capturedTurns,
              shouldComplete: () => true,
              response: (turn) =>
                turn.message.text === delegatedPrompt
                  ? delegatedResult
                  : `Claude completed: ${turn.message.text}`,
            }),
          ]);
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
          );
          const orchestrationLayer = Layer.merge(
            orchestratorLayer,
            threadManagementServiceLayer.pipe(Layer.provide(orchestratorLayer)),
          );
          const providerRegistryLayer = makeProviderRegistryLayer([
            makeProviderSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: codexModel,
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
          const testLayer = McpHttpServer.OrchestratorToolkitRegistrationLive.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provideMerge(orchestrationLayer),
            Layer.provide(providerRegistryLayer),
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

            const capabilitiesTool = server.tools.find(
              ({ tool }) => tool.name === "orchestrator_capabilities",
            );
            expect(capabilitiesTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(capabilitiesTool?.tool.annotations?.idempotentHint).toBe(true);
            const delegateTool = server.tools.find(({ tool }) => tool.name === "delegate_task");
            expect(delegateTool?.tool.annotations?.destructiveHint).toBe(true);
            expect(delegateTool?.tool.annotations?.openWorldHint).toBe(true);
            const createThreadsTool = server.tools.find(
              ({ tool }) => tool.name === "create_threads",
            );
            expect(createThreadsTool?.tool.annotations?.destructiveHint).toBe(true);
            const threadListTool = server.tools.find(({ tool }) => tool.name === "t3_thread_list");
            expect(threadListTool?.tool.annotations?.readOnlyHint).toBe(true);
            expect(threadListTool?.tool.annotations?.idempotentHint).toBe(true);
            const threadReadTool = server.tools.find(({ tool }) => tool.name === "t3_thread_read");
            expect(threadReadTool?.tool.annotations?.readOnlyHint).toBe(true);
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
              ]),
            });

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

            const cancellableCall = yield* invoke("delegate_task", {
              task: cancellationPrompt,
              target: {
                providerInstanceId: codexInstanceId,
                model: codexModel,
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
          }).pipe(Effect.provide(testLayer));
        }),
      ),
  );
});
