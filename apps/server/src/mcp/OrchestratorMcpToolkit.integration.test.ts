import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { PermissionRuleset } from "@opencode-ai/sdk/v2";
import {
  CommandId,
  EnvironmentId,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadSendResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { OpenCodeAdapterV2Driver } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_PROVIDER,
  openCodeToolDecision,
} from "@t3tools/provider-opencode/testing";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.

const parentThreadId = ThreadId.make("thread:mcp-orchestrator-parent");
const projectId = ProjectId.make("project:mcp-orchestrator");
const codexInstanceId = ProviderInstanceId.make("codex");
const codexModel = "gpt-5.4";
const parentPrompt = "Keep this parent turn active while orchestration tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadInterruptResult = Schema.decodeUnknownEffect(
  OrchestratorMcpThreadInterruptResult,
);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(function* (
  followupResult: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    decodeURIComponent(delegatedTaskStatusTranscriptFile.pathname),
  );
  return yield* decodeProviderReplayNdjson(text.replaceAll(queuedFollowupResult, followupResult));
}, Effect.provide(NodeServices.layer));

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

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerMemorySecretStore = Layer.sync(ServerSecretStore.ServerSecretStore, () => {
  const stored = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(stored.get(name))),
    set: (name, value) => Effect.sync(() => void stored.set(name, value)),
    create: (name, value) => Effect.sync(() => void stored.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const existing = stored.get(name);
        if (existing) return existing;
        const value = new Uint8Array(bytes).fill(7);
        stored.set(name, value);
        return value;
      }),
    remove: (name) => Effect.sync(() => void stored.delete(name)),
  });
});

const layerUnusedScheduledTaskStub = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("ScheduledTaskService.upsert is unused in this test"),
    setEnabled: () => Effect.die("ScheduledTaskService.setEnabled is unused in this test"),
    delete: () => Effect.die("ScheduledTaskService.delete is unused in this test"),
    deleteForThread: () => Effect.die("unused in this test"),
    runNow: () => Effect.die("ScheduledTaskService.runNow is unused in this test"),
    rotateWebhookToken: () => Effect.die("unused in this test"),
    listWebhookDeliveries: () => Effect.die("unused in this test"),
    getWebhookDelivery: () => Effect.die("unused in this test"),
    triggerWebhook: () => Effect.die("unused in this test"),
  }),
);

describe("orchestrator MCP toolkit", () => {
  it.live.each([
    { label: "distinct", result: queuedFollowupResult, latestSummary: queuedFollowupResult },
    { label: "identical", result: delegatedResult, latestSummary: null },
  ])("reports $label child results", ({ result, latestSummary }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-task-status");
        const rawTranscript = yield* readDelegatedTaskStatusTranscript(result);
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
        );
        const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
          {
            name: "delegated-task-status/codex",
            transcript,
            commands: [],
            runtimePolicyOverride: { cwd },
          },
          CodexOrchestratorReplayHarness,
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerProviderRegistry = ProviderRegistryMock.layer([
          makeProviderSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: codexModel,
          }),
        ]);
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(
            CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
              Layer.provide(McpProviderSessions.layer),
            ),
          ),
          Layer.provide(layerProviderRegistry),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(layerOrchestration),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
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
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: parentCreate.sequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Parent provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:mcp-replay"),
            requestNamespace: "mcp-provider-session-replay-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-replay-parent",
              providerInstanceId: codexInstanceId,
            },
            client: undefined,
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

          const delegationStartSequence =
            yield* orchestrator.getThreadEventSequence(parentThreadId);
          const delegatedCall = yield* invoke("delegate_task", {
            task: delegatedPrompt,
            target: {
              providerInstanceId: codexInstanceId,
              model: codexModel,
            },
            mode: "async",
            clientRequestId: "delegate-codex-replay-1",
          });
          const delegatedStart = yield* decodeDelegateTaskResult(
            delegatedCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegatedStart.childRunId).not.toBeNull();
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: delegationStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "context-transfer.created" &&
                  stored.event.payload.type === "subagent_result" &&
                  stored.event.payload.sourceThreadId === delegatedStart.childThreadId &&
                  stored.event.payload.sourcePoint.runId === delegatedStart.childRunId,
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Delegated result transfer was not created."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const delegatedStatusCall = yield* invoke("task_status", {
            taskId: delegatedStart.taskId,
          });
          const delegated = yield* decodeDelegateTaskResult(
            delegatedStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(delegated).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            providerInstanceId: codexInstanceId,
            hasPendingChildRuns: false,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });
          expect(delegated.resultContextTransferId).not.toBeNull();

          const delegatedChild = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(delegatedChild.thread.lineage.relationshipToParent).toBe("subagent");
          expect(isProviderNativeSubagentThread(delegatedChild.thread)).toBe(false);
          const followupStartSequence = yield* orchestrator.getThreadEventSequence(
            delegated.childThreadId,
          );
          const runningFollowupCall = yield* invoke("t3_thread_send", {
            threadId: delegated.childThreadId,
            message: cancellationPrompt,
            clientRequestId: "delegated-child-replay-running-1",
          });
          const runningFollowup = yield* decodeThreadSendResult(
            runningFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: followupStartSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "provider-turn.updated" &&
                  stored.event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up provider turn did not start."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const queuedFollowupCall = yield* invoke("t3_thread_send", {
            threadId: delegated.childThreadId,
            message: queuedFollowupPrompt,
            mode: "queue",
            clientRequestId: "delegated-child-replay-queued-1",
          });
          const queuedFollowup = yield* decodeThreadSendResult(
            queuedFollowupCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(queuedFollowup).toMatchObject({
            status: "queued",
            delivery: "queued",
          });

          const pendingProjection = yield* orchestrator.getThreadProjection(
            delegated.childThreadId,
          );
          const followupTasks = (yield* orchestrator.getThreadProjection(
            parentThreadId,
          )).subagents.filter(
            (task) =>
              task.childThreadId === delegated.childThreadId && task.id !== delegated.taskId,
          );
          expect(followupTasks).toHaveLength(2);
          expect(followupTasks.every((task) => task.result === null)).toBe(true);
          expect(followupTasks.map((task) => task.id)).toEqual([
            runningFollowup.taskId,
            queuedFollowup.taskId,
          ]);
          expect(
            pendingProjection.runs.find((run) => run.id === delegated.childRunId)?.status,
          ).toBe("completed");
          expect(
            pendingProjection.runs.find((run) => run.id === runningFollowup.runId)?.status,
          ).toBe("running");
          expect(
            pendingProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status,
          ).toBe("queued");
          expect(
            (yield* orchestrator.getThreadProjection(parentThreadId)).runs.some(
              (run) => run.status === "running",
            ),
          ).toBe(true);

          const pendingStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const pendingStatus = yield* decodeDelegateTaskResult(
            pendingStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(pendingStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: true,
            latestTerminalRunId: delegated.childRunId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: null,
            latestTerminalResultContextTransferId: null,
          });

          const finalSequence = yield* orchestrator.getThreadEventSequence(delegated.childThreadId);
          const interruptCall = yield* invoke("t3_thread_interrupt", {
            threadId: delegated.childThreadId,
            runId: runningFollowup.runId,
            reason: "Allow the queued replay follow-up to run.",
            clientRequestId: "interrupt-delegated-child-replay-1",
          });
          const interrupt = yield* decodeThreadInterruptResult(
            interruptCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(interrupt).toMatchObject({
            runId: runningFollowup.runId,
            status: "interrupt_requested",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: delegated.childThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  stored.event.payload.id === queuedFollowup.runId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Queued follow-up did not complete."),
                  onSome: () => Effect.void,
                }),
              ),
            );

          const finalProjection = yield* orchestrator.getThreadProjection(delegated.childThreadId);
          expect(finalProjection.runs.find((run) => run.id === runningFollowup.runId)?.status).toBe(
            "interrupted",
          );
          expect(finalProjection.runs.find((run) => run.id === queuedFollowup.runId)?.status).toBe(
            "completed",
          );
          expect(
            finalProjection.turnItems.find(
              (item) =>
                item.runId === runningFollowup.runId && item.type === "run_interrupt_result",
            ),
          ).toMatchObject({
            message: "Stopped by an agent: Allow the queued replay follow-up to run.",
          });
          yield* orchestrator
            .streamStoredEventsFrom({
              threadId: parentThreadId,
              afterSequence: finalSequence,
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === followupTasks[1]!.id &&
                  stored.event.payload.status === "completed",
              ),
              Stream.runHead,
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.die("Follow-up task did not settle."),
                  onSome: () => Effect.void,
                }),
              ),
            );
          const finishedParent = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[0]!.id)?.status,
          ).toBe("interrupted");
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id),
          ).toMatchObject({
            status: "completed",
            result,
          });
          expect(
            finishedParent.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === delegated.childThreadId,
            ),
          ).toHaveLength(3);
          expect(
            finishedParent.subagents.find((task) => task.id === followupTasks[1]!.id)
              ?.completionDelivery?.state,
          ).toBe("claimed");
          const finalStatusCall = yield* invoke("task_status", {
            taskId: delegated.taskId,
          });
          const finalStatus = yield* decodeDelegateTaskResult(
            finalStatusCall.structuredContent,
          ).pipe(Effect.orDie);
          expect(finalStatus).toMatchObject({
            childRunId: delegated.childRunId,
            status: "completed",
            summary: delegatedResult,
            resultContextTransferId: delegated.resultContextTransferId,
            hasPendingChildRuns: false,
            latestTerminalRunId: queuedFollowup.runId,
            latestTerminalStatus: "completed",
            latestTerminalSummary: latestSummary,
          });
          const followupTransfer = finishedParent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourcePoint.runId === queuedFollowup.runId,
          );
          expect(followupTransfer).toBeDefined();
          expect(finalStatus.latestTerminalResultContextTransferId).toBe(followupTransfer?.id);
          expect(finalStatus.latestTerminalResultContextTransferId).not.toBe(
            delegated.resultContextTransferId,
          );
          const read = yield* invoke("t3_thread_read", {
            threadId: delegated.childThreadId,
            limit: 100,
          });
          expect(read.isError).not.toBe(true);
          const afterRead = yield* orchestrator.getThreadProjection(parentThreadId);
          expect(
            afterRead.subagents.find((task) => task.id === queuedFollowup.taskId)
              ?.completionDelivery?.state,
          ).toBe("acknowledged");
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
  // A delegated reviewer pinned to a read-only OpenCode agent redirected shell
  // output into /tmp: the child's full access overrode the agent's denies.
  it.live("delegate_task runs an OpenCode review agent without the tools it denies", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-opencode-review");
        const instanceId = ProviderInstanceId.make(OPENCODE_DEFAULT_INSTANCE_ID);
        const model = "anthropic/claude-sonnet";
        // The agent as OpenCode resolves it from opencode.json: the user's
        // global allow, then the agent's own rules.
        const review: PermissionRuleset = [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "*", pattern: "*", action: "deny" },
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "glob", pattern: "*", action: "allow" },
          { permission: "grep", pattern: "*", action: "allow" },
          { permission: "list", pattern: "*", action: "allow" },
          { permission: "edit", pattern: "*", action: "deny" },
          { permission: "bash", pattern: "*", action: "deny" },
          { permission: "task", pattern: "*", action: "deny" },
        ];
        // Another session on the same OpenCode server answered "always" for shell.
        const approved: PermissionRuleset = [{ permission: "bash", pattern: "*", action: "allow" }];
        const sessions = new Map<
          string,
          { readonly id: string; readonly permission?: PermissionRuleset }
        >();
        let markParentStarted!: () => void;
        const parentStarted = new Promise<void>((resolve) => {
          markParentStarted = resolve;
        });
        let childPrompted!: (prompt: {
          readonly agent: unknown;
          readonly variant: unknown;
          readonly ran: ReadonlyArray<string>;
        }) => void;
        const childPrompt = new Promise<Parameters<typeof childPrompted>[0]>((resolve) => {
          childPrompted = resolve;
        });
        const openCodeClient = {
          event: {
            subscribe: async (_input?: unknown, options?: { readonly signal?: AbortSignal }) => ({
              stream: {
                [Symbol.asyncIterator]: () => ({
                  next: () =>
                    new Promise<IteratorResult<never>>((resolve) => {
                      const done = () => resolve({ done: true, value: undefined });
                      if (options?.signal?.aborted) return done();
                      options?.signal?.addEventListener("abort", done, { once: true });
                    }),
                }),
              },
            }),
          },
          app: {
            agents: async () => ({
              data: [{ name: "review", mode: "primary", options: {}, permission: review }],
            }),
          },
          session: {
            create: async (input: { readonly permission?: PermissionRuleset }) => {
              const nativeSession = {
                id: `native-${sessions.size + 1}`,
                permission: input.permission ?? [],
                time: { created: 1, updated: 1 },
              };
              sessions.set(nativeSession.id, nativeSession);
              return { data: nativeSession };
            },
            get: async ({ sessionID }: { readonly sessionID: string }) => ({
              data: sessions.get(sessionID),
            }),
            update: async (input: {
              readonly sessionID: string;
              readonly permission: PermissionRuleset;
            }) => {
              const existing = sessions.get(input.sessionID)!;
              // OpenCode appends updated rules after the session's own.
              const nativeSession = {
                ...existing,
                permission: [...(existing.permission ?? []), ...input.permission],
              };
              sessions.set(input.sessionID, nativeSession);
              return { data: nativeSession };
            },
            promptAsync: async (input: {
              readonly sessionID: string;
              readonly agent?: string;
              readonly variant?: string;
            }) => {
              if (input.agent === undefined) {
                markParentStarted();
                return { data: true };
              }
              const rules = [...review, ...(sessions.get(input.sessionID)?.permission ?? [])];
              // What OpenCode would spawn or write for the reviewer's redirect,
              // an edit, a nested task, a T3 MCP write, and the read it needs.
              const ran = (
                [
                  ["bash", "git diff > /tmp/review.diff"],
                  ["write", "notes.md"],
                  ["task", "general"],
                  ["t3-code_delegate_task", "*"],
                  ["read", "src/index.ts"],
                ] as const
              ).flatMap(([tool, pattern]) =>
                openCodeToolDecision(rules, approved, tool, pattern) === "allow" ? [tool] : [],
              );
              childPrompted({ agent: input.agent, variant: input.variant, ran });
              return { data: true };
            },
            abort: async () => ({ data: true }),
            children: async () => ({ data: [] }),
          },
        };
        const layerRegistry = ProviderAdapterRegistry.layerFromDrivers({
          drivers: [OpenCodeAdapterV2Driver],
          configMap: {
            [instanceId]: {
              driver: OPENCODE_PROVIDER,
              config: { serverUrl: "http://test.invalid" },
            },
          },
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, {
                connectToOpenCodeServer: () =>
                  Effect.succeed({
                    url: "http://test.invalid",
                    version: "test",
                    exitCode: null,
                    external: true,
                  }),
                createOpenCodeSdkClient: () => openCodeClient,
              } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
              TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
              NodeServices.layer,
              IdAllocator.layer,
              Layer.succeed(
                ProviderEventLoggers.ProviderEventLoggers,
                ProviderEventLoggers.NoOpProviderEventLoggers,
              ),
            ),
          ),
        );
        // OpenCode is off until its instance is enabled.
        const layerSettings = ServerSettings.layerTest({
          providerInstances: { [instanceId]: { driver: OPENCODE_PROVIDER, enabled: true } },
        });
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "delegated-opencode-review" },
          layerRegistry,
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(layerSettings),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerTest = layerOrchestratorToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(layerRegistry.pipe(Layer.provide(McpProviderSessions.layer))),
          Layer.provide(
            ProviderRegistryMock.layer([
              makeProviderSnapshot({
                instanceId,
                driver: ProviderDriverKind.make(OPENCODE_PROVIDER),
                model,
                optionDescriptors: [
                  {
                    id: "variant",
                    label: "Variant",
                    type: "select",
                    options: [{ id: "high", label: "High" }],
                  },
                  {
                    id: "agent",
                    label: "Agent",
                    type: "select",
                    options: [{ id: "review", label: "Review" }],
                  },
                ],
              }),
            ]),
          ),
          Layer.provide(layerSettings),
          Layer.provide(layerUnusedScheduledTaskStub),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provideMerge(
            SecretRequests.layer.pipe(
              Layer.provide(layerMemorySecretStore),
              Layer.provide(layerOrchestration),
            ),
          ),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          const selection = { instanceId, model } satisfies ModelSelection;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:opencode-review-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "OpenCode review parent",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:opencode-review-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:opencode-review-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Effect.promise(() => parentStarted);

          const invocation: McpInvocationContext.McpInvocationScope = {
            environmentId: EnvironmentId.make("environment:opencode-review"),
            requestNamespace: "mcp-provider-session-opencode-review-parent",
            thread: {
              threadId: parentThreadId,
              providerSessionId: "mcp-provider-session-opencode-review-parent",
              providerInstanceId: instanceId,
            },
            client: undefined,
            capabilities: new Set(["orchestration"]),
            issuedAt: 1,
          };
          const delegated = yield* server
            .callTool({
              name: "delegate_task",
              arguments: {
                task: "Review the change and report findings.",
                role: "review",
                target: {
                  providerInstanceId: instanceId,
                  model,
                  options: [
                    { id: "variant", value: "high" },
                    { id: "agent", value: "review" },
                  ],
                },
                mode: "async",
                clientRequestId: "delegate-opencode-review-1",
              },
            })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          expect(delegated.isError).not.toBe(true);
          expect(yield* Effect.promise(() => childPrompt)).toEqual({
            agent: "review",
            variant: "high",
            ran: ["read"],
          });
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
});
