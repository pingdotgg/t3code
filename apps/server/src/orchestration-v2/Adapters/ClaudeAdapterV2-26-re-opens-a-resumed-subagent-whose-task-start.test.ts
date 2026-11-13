// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";
import type {
  ElicitationRequest,
  Query as ClaudeQuery,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AskUserQuestionInput,
  TaskCreateInput,
  TaskCreateOutput,
  TaskListOutput,
  TaskUpdateInput,
  TaskUpdateOutput,
} from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  type ChatAttachment,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  type ResolvedProviderInstanceEnvironment,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  type ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Tool } from "effect/ai";
import { formatClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as PortScanner from "../../preview/PortScanner.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { WorkflowAgentTranscriptReadObserver } from "../workflowAgentTranscript.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { ClaudeExecutableFileCheck } from "../../provider/Drivers/ClaudeExecutable.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ClaudeOrchestratorReplayHarness } from "./ClaudeAdapterV2.testkit.ts";
import { provideDeterministicTestRuntime } from "../testkit/DeterministicRuntime.ts";
import { runOrchestratorV2Scenario } from "../testkit/OrchestratorScenario.ts";
import { layerProviderReplay } from "../testkit/ProviderReplayHarness.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  CLAUDE_MODEL_SELECTION,
  materializeFixtureInput,
  projectionFor,
} from "../testkit/fixtures/shared.ts";

import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RESTART_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  encodeJsonString,
  WAKE_NATIVE_SESSION,
  WAKE_TASK_ID,
  WAKE_SUMMARY,
  WAKE_RESULT_TEXT,
  claudeSdkFrame,
  wakeTaskStarted,
  makeResultFrame,
  turnOneResult,
  wakeNotification,
  wakeResult,
  makeChangeSignal,
  yieldTicks,
  makeWakeHarness,
  providerThreadRosterEvents,
  makeSubagentAssistantFrames,
  makeSubagentToolResultFrame,
} from "./ClaudeAdapterV2-fixtures.testkit.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));
beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("re-opens a resumed subagent whose task_started races past settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-resume-postsettle";
        const SUBAGENT_TOOL_USE_ID = "toolu-resume-postsettle";
        const RESUME_TOOL_USE_ID = "toolu-resume-postsettle-sendmessage";
        const FIRST_SUMMARY = "Answered early.";
        const SECOND_SUMMARY = "RESUME_SETTLE_DONE";
        const subagentTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          description: "Sleep then echo done token",
          subagent_type: "general-purpose",
          task_type: "local_agent",
          prompt: "Run the shell command, then return exactly RESUME_SETTLE_DONE.",
          uuid: "00000000-0000-4000-8000-000000000501",
          session_id: WAKE_NATIVE_SESSION,
        });
        const firstNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: SUBAGENT_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: FIRST_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000502",
          session_id: WAKE_NATIVE_SESSION,
        });
        const resumeTaskStarted = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          description: "Sleep then echo done token",
          is_backgrounded: true,
          task_type: "local_agent",
          uuid: "00000000-0000-4000-8000-000000000505",
          session_id: WAKE_NATIVE_SESSION,
        });
        const secondNotification = claudeSdkFrame({
          type: "system",
          subtype: "task_notification",
          task_id: SUBAGENT_TASK_ID,
          tool_use_id: RESUME_TOOL_USE_ID,
          status: "completed",
          output_file: "/tmp/task-resume-postsettle.output",
          summary: SECOND_SUMMARY,
          uuid: "00000000-0000-4000-8000-000000000506",
          session_id: WAKE_NATIVE_SESSION,
        });

        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const subagentEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "subagent.updated" }
            > => event.type === "subagent.updated",
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, subagentTaskStarted);
        yield* harness.until(() => subagentEvents().length >= 1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000503",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* harness.awaitTerminal(1);

        yield* Queue.offer(harness.sdkMessages, firstNotification);
        yield* harness.awaitContinuation(1);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000504",
            result: "The subagent answered early.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9b"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(2);
        assert.equal(subagentEvents().at(-1)?.subagent.status, "completed");
        assert.equal(subagentEvents().at(-1)?.subagent.result, FIRST_SUMMARY);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_resume_postsettle_sendmessage",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: RESUME_TOOL_USE_ID,
                  name: "SendMessage",
                  input: {
                    to: SUBAGENT_TASK_ID,
                    summary: "Resume the subagent",
                    message: "Continue and return the token.",
                  },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000508",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, resumeTaskStarted);
        const resumeAck = {
          success: true,
          message: `Resuming agent ${SUBAGENT_TASK_ID.slice(0, 7)}`,
          resumedAgentId: SUBAGENT_TASK_ID,
          pin: { id: SUBAGENT_TASK_ID, name: SUBAGENT_TASK_ID, ref: "42ab31" },
        };
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  tool_use_id: RESUME_TOOL_USE_ID,
                  type: "tool_result",
                  content: [
                    {
                      type: "text",
                      text: encodeJsonString(resumeAck),
                    },
                  ],
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000509",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: resumeAck,
          }),
        );
        for (const frame of [
          ...makeSubagentAssistantFrames({
            parentToolUseId: SUBAGENT_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000961",
            text: "RESUMED_WORK",
            bashToolUseId: "toolu-resume-postsettle-bash",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: SUBAGENT_TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000962",
            toolUseId: "toolu-resume-postsettle-bash",
          }),
        ]) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* Queue.offer(harness.sdkMessages, secondNotification);
        yield* harness.awaitContinuation(2);
        assert.equal(harness.continuationRequests[1]?.detail, SECOND_SUMMARY);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000507",
            result: "The subagent finished with RESUME_SETTLE_DONE.",
          }),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-9c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(3);

        const statuses = subagentEvents().map((event) => event.subagent.status);
        const firstCompleted = statuses.indexOf("completed");
        const reopenedIndex = statuses.lastIndexOf("running");
        assert.isAbove(reopenedIndex, firstCompleted);
        assert.isNull(subagentEvents()[reopenedIndex]?.subagent.result);
        assert.equal(subagentEvents()[reopenedIndex]?.subagent.runId, "run-attempt-claude-wake-9c");
        const nodeStatuses = harness.events
          .filter(
            (
              event,
            ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> =>
              event.type === "node.updated" &&
              event.node.kind === "subagent" &&
              event.node.nativeItemRef?.nativeId === SUBAGENT_TASK_ID,
          )
          .map((event) => event.node.status);
        assert.isAbove(nodeStatuses.lastIndexOf("running"), nodeStatuses.indexOf("completed"));
        const finalSubagent = subagentEvents().at(-1)?.subagent;
        assert.equal(finalSubagent?.status, "completed");
        assert.equal(finalSubagent?.result, SECOND_SUMMARY);
        assert.equal(finalSubagent?.runId, "run-attempt-claude-wake-9c");
        const reopenIndex = harness.events.findIndex(
          (event) =>
            event.type === "subagent.updated" &&
            event.subagent.status === "running" &&
            event.subagent.runId === "run-attempt-claude-wake-9c",
        );
        assert.isAtLeast(reopenIndex, 0);
        const resumedWorkIndexes = harness.events.flatMap((event, index) =>
          event.type === "message.updated" && event.message.text === "RESUMED_WORK" ? [index] : [],
        );
        assert.lengthOf(resumedWorkIndexes, 1);
        assert.isAbove(resumedWorkIndexes[0] ?? -1, reopenIndex);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
  it.effect("resets Waiting roster and wake eligibility when the CLI process is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const changes = yield* makeChangeSignal;
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-process-reset-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
        const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
          [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          random: yield* SecureRandom.SecureRandom,
          idAllocator,
          continuationRequests: {
            offer: (request) =>
              Effect.sync(() => {
                continuationRequests.push(request);
              }).pipe(Effect.andThen(changes.notify)),
          },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                processQueues.push(sdkMessages);
                return {
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-process-reset");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-process-reset"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }).pipe(Effect.andThen(changes.notify)),
          ),
          Effect.forkScoped,
        );
        if (runtime.hasPendingBackgroundWork === undefined) {
          return yield* Effect.die("Claude adapter runtime must expose hasPendingBackgroundWork.");
        }
        const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-process-reset-a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        assert.equal(processQueues.length, 1);
        const firstProcess = processQueues[0]!;
        yield* Queue.offer(firstProcess, wakeTaskStarted);
        yield* Queue.offer(
          firstProcess,
          claudeSdkFrame({
            type: "system",
            subtype: "background_tasks_changed",
            tasks: [],
            uuid: "00000000-0000-4000-8000-000000000603",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(firstProcess, turnOneResult);
        yield* changes.until(() => events.some((event) => event.type === "turn.terminal"));
        assert.isFalse(yield* hasPendingBackgroundWork);

        const alternateModel = CLAUDE_TEST_RESTART_MODEL_SELECTION;
        const activeProviderThread = {
          ...providerThread,
          status: "active" as const,
        } satisfies OrchestrationV2ProviderThread;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: activeProviderThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-process-reset-b"),
            text: "Continue after process restart.",
            attachments: [],
            providerTurnOrdinal: 2,
            modelSelection: alternateModel,
          }),
        );
        assert.equal(processQueues.length, 2);

        yield* changes.until(() =>
          providerThreadRosterEvents(events).some(
            (event) =>
              event.providerThread.status === "active" &&
              (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0 &&
              event.providerThread.updatedAt !== undefined,
          ),
        );
        assert.isFalse(yield* hasPendingBackgroundWork);
        const emptyActiveRosterEvents = providerThreadRosterEvents(events).filter(
          (event) =>
            event.providerThread.status === "active" &&
            (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
        );
        assert.isAtLeast(emptyActiveRosterEvents.length, 1);
        assert.deepEqual(
          emptyActiveRosterEvents.at(-1)?.providerThread.pendingBackgroundTasks ?? [],
          [],
        );
        assert.equal(emptyActiveRosterEvents.at(-1)?.providerThread.status, "active");

        const secondProcess = processQueues[1]!;
        yield* Queue.offer(secondProcess, wakeNotification);
        yield* yieldTicks(50);
        assert.lengthOf(continuationRequests, 0);

        yield* Queue.offer(
          secondProcess,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000602",
            result: "Process restart turn finished.",
          }),
        );
        yield* changes.until(
          () => events.filter((event) => event.type === "turn.terminal").length === 2,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );
  it.effect(
    "preserves buffered local_bash notification classification across model/policy query replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* makeChangeSignal;
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-buffer-replace-",
          });
          const processQueues: Array<Queue.Queue<SDKMessage>> = [];
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
          const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
            [];
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            random: yield* SecureRandom.SecureRandom,
            idAllocator,
            continuationRequests: {
              offer: (request) =>
                Effect.sync(() => {
                  continuationRequests.push(request);
                }).pipe(Effect.andThen(changes.notify)),
            },
            queryRunner: {
              allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
              open: () =>
                Effect.gen(function* () {
                  const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push(sdkMessages);
                  return {
                    messages: Stream.fromQueue(sdkMessages),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(sdkMessages),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-buffer-replace");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-buffer-replace"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          yield* runtime.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }).pipe(Effect.andThen(changes.notify)),
            ),
            Effect.forkScoped,
          );
          if (runtime.hasPendingBackgroundWork === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWork.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-a"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const firstProcess = processQueues[0]!;
          yield* Queue.offer(firstProcess, wakeTaskStarted);
          yield* Queue.offer(firstProcess, turnOneResult);
          yield* changes.until(() => events.some((event) => event.type === "turn.terminal"));
          assert.isTrue(yield* hasPendingBackgroundWork);

          yield* Queue.offer(firstProcess, wakeNotification);
          yield* yieldTicks(50);
          assert.lengthOf(continuationRequests, 0);

          const alternateModel = CLAUDE_TEST_RESTART_MODEL_SELECTION;
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-user"),
              text: "Switch model while background work completes.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
          assert.equal(processQueues.length, 2);
          const secondProcess = processQueues[1]!;
          yield* Queue.offer(
            secondProcess,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000701",
              result: "User turn finished after model switch.",
            }),
          );
          yield* changes.until(
            () => events.filter((event) => event.type === "turn.terminal").length === 2,
          );
          assert.isFalse(yield* hasPendingBackgroundWork);
          assert.lengthOf(continuationRequests, 0);

          yield* Queue.offer(secondProcess, wakeResult);
          yield* changes.until(() => continuationRequests.length === 1);
          assert.equal(continuationRequests[0]?.detail, WAKE_SUMMARY);
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-claude-buffer-replace-cont"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 3,
              modelSelection: alternateModel,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* changes.until(
            () => events.filter((event) => event.type === "turn.terminal").length === 3,
          );
          assert.isTrue(
            events.some(
              (event) =>
                event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
            ),
          );
          assert.isFalse(
            events.some(
              (event) =>
                event.type === "subagent.updated" ||
                (event.type === "node.updated" && event.node.kind === "subagent"),
            ),
          );
          assert.isFalse(
            events.some(
              (event) =>
                event.type !== "provider_thread.updated" &&
                JSON.stringify(event).includes(WAKE_TASK_ID),
            ),
          );
          assert.isFalse(yield* hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );
});
