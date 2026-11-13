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
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  options,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  wakeTaskStarted,
  makeAssistantTextFrame,
  makeResultFrame,
  wakeNotification,
  wakeResult,
  makeChangeSignal,
  makeWakeHarness,
  providerThreadRosterEvents,
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
  it.effect(
    "clears the replaced sibling native thread roster when openQuery switches processes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const changes = yield* makeChangeSignal;
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-sibling-replace-",
          });
          const nativeIds = ["native-thread-roster-a", "native-thread-roster-b"] as const;
          let allocateIndex = 0;
          // A shared queue would hide sibling process death on replacement.
          const processQueues: Array<{
            readonly nativeThreadId: string;
            readonly queue: Queue.Queue<SDKMessage>;
          }> = [];
          const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
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
              offer: () => Effect.void,
            },
            queryRunner: {
              allocateSessionId: Effect.sync(() => {
                const next =
                  nativeIds[allocateIndex] ?? `native-thread-roster-extra-${allocateIndex}`;
                allocateIndex += 1;
                return next;
              }),
              open: (openInput) =>
                Effect.gen(function* () {
                  const nativeThreadId = openInput.options.sessionId ?? openInput.options.resume;
                  if (typeof nativeThreadId !== "string" || nativeThreadId.length === 0) {
                    return yield* Effect.die("openQuery must supply a native session id");
                  }
                  const queue = yield* Queue.unbounded<SDKMessage>();
                  processQueues.push({ nativeThreadId, queue });
                  return {
                    messages: Stream.fromQueue(queue),
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(queue),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const appThreadA = ThreadId.make("thread-claude-roster-a");
          const appThreadB = ThreadId.make("thread-claude-roster-b");
          const runtime = yield* adapter.openSession({
            threadId: appThreadA,
            providerSessionId: ProviderSessionId.make("provider-session-claude-sibling-replace"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadA = yield* runtime.ensureThread({
            threadId: appThreadA,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThreadB = yield* runtime.ensureThread({
            threadId: appThreadB,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          assert.notEqual(
            providerThreadA.nativeThreadRef?.nativeId,
            providerThreadB.nativeThreadRef?.nativeId,
          );
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
          if (runtime.hasPendingBackgroundWorkForThread === undefined) {
            return yield* Effect.die(
              "Claude adapter runtime must expose hasPendingBackgroundWorkForThread.",
            );
          }
          const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
          const hasPendingBackgroundWorkForThread = runtime.hasPendingBackgroundWorkForThread;
          const now = yield* DateTime.now;
          const taskA = "task-roster-a";
          const taskB = "task-roster-b";

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadA,
              providerThread: providerThreadA,
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-a"),
              text: "Background work on A.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 1);
          const processA = processQueues[0]!;
          yield* Queue.offer(
            processA.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskA,
              tool_use_id: "toolu-roster-a",
              description: "work on A",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000301",
              session_id: nativeIds[0],
            }),
          );
          yield* Queue.offer(
            processA.queue,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000302",
              result: "A settled with background work.",
            }),
          );
          yield* changes.until(() =>
            events.some(
              (event) =>
                event.type === "turn.terminal" &&
                event.providerThreadId === providerThreadA.id &&
                event.status === "completed",
            ),
          );
          const rosterAAfterSettle = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadA.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterAAfterSettle ?? [], [
            { taskId: taskA, description: "work on A", kind: "command" },
          ]);
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: appThreadB,
              providerThread: { ...providerThreadB, status: "active" },
              now,
              attemptId: RunAttemptId.make("attempt-roster-iso-b"),
              text: "Background work on B.",
              attachments: [],
            }),
          );
          assert.equal(processQueues.length, 2);
          yield* changes.until(() =>
            providerThreadRosterEvents(events).some(
              (event) =>
                event.providerThread.id === providerThreadA.id &&
                event.providerThread.status === "idle" &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) === 0,
            ),
          );
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          const processB = processQueues[1]!;
          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: taskB,
              tool_use_id: "toolu-roster-b",
              description: "work on B",
              is_backgrounded: true,
              task_type: "local_bash",
              uuid: "00000000-0000-4000-8000-000000000303",
              session_id: nativeIds[1],
            }),
          );
          yield* changes.until(() =>
            providerThreadRosterEvents(events).some(
              (event) =>
                event.providerThread.id === providerThreadB.id &&
                (event.providerThread.pendingBackgroundTasks?.length ?? 0) > 0,
            ),
          );
          assert.isTrue(yield* hasPendingBackgroundWorkForThread(providerThreadB));
          assert.isTrue(yield* hasPendingBackgroundWork);
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));

          yield* Queue.offer(
            processB.queue,
            claudeSdkFrame({
              type: "result",
              subtype: "error_during_execution",
              duration_ms: 10,
              duration_api_ms: 10,
              is_error: true,
              num_turns: 1,
              result: "B failed",
              stop_reason: "end_turn",
              total_cost_usd: 0,
              usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
              },
              modelUsage: {},
              permission_denials: [],
              errors: ["B failed"],
              terminal_reason: "model_error",
              uuid: "00000000-0000-4000-8000-000000000304",
              session_id: nativeIds[1],
            }),
          );
          yield* changes.until(() =>
            events.some(
              (event) =>
                event.type === "turn.terminal" &&
                event.providerThreadId === providerThreadB.id &&
                event.status === "failed",
            ),
          );

          const rosterBAfterFail = providerThreadRosterEvents(events).findLast(
            (event) => event.providerThread.id === providerThreadB.id,
          )?.providerThread.pendingBackgroundTasks;
          assert.deepEqual(rosterBAfterFail ?? [], []);
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadA));
          assert.isFalse(yield* hasPendingBackgroundWorkForThread(providerThreadB));
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
  it.effect.each(["full-access", "approval-required"] as const)(
    "keeps a queued wake turn's tool callback with its continuation in %s mode",
    (runtimeMode) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode,
            interactionMode: "default",
            cwd: "/workspace",
          });
          const firstAttempt = RunAttemptId.make("attempt-claude-wake-callback-1");
          const userAttempt = RunAttemptId.make("attempt-claude-wake-callback-2");
          const continuationAttempt = RunAttemptId.make("attempt-claude-wake-callback-3");
          const planToolUseId = "toolu_01WakePlanExitPlanMode";
          const planMarkdown = "# Wake plan\n\n1. Report the background result.";
          const stamp = (frame: SDKMessage, promptIndex: number) =>
            claudeSdkFrame({
              ...frame,
              user_message_uuid: harness.promptUuid(promptIndex),
            });
          const runOf = (attemptId: RunAttemptId) => RunId.make(`run-${attemptId}`);
          const planToolUse = claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_wake_plan",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: planToolUseId,
                  name: "ExitPlanMode",
                  input: { plan: planMarkdown },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000741",
            session_id: WAKE_NATIVE_SESSION,
          });
          const planToolResult = claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: planToolUseId,
                  content:
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                  is_error: true,
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000742",
            session_id: WAKE_NATIVE_SESSION,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: firstAttempt,
              text: "Run the build in the background.",
              attachments: [],
              runtimePolicy,
            }),
          );
          yield* Queue.offer(harness.sdkMessages, stamp(wakeTaskStarted, 0));
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000740", result: "STARTED" }),
              0,
            ),
          );
          yield* harness.awaitTerminal(1);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: userAttempt,
              text: "Reply with exactly: USER_REPLY",
              attachments: [],
              runtimePolicy,
              providerTurnOrdinal: 2,
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          // The SDK asks for permission only after streaming the tool_use.
          yield* harness.offerAndWait(planToolUse);
          const canUseTool = harness.getOpenedOptions()?.canUseTool;
          assert.isFunction(canUseTool);
          const callback = yield* Effect.promise(() =>
            canUseTool!(
              "ExitPlanMode",
              { plan: planMarkdown },
              {
                signal: new AbortController().signal,
                toolUseID: planToolUseId,
                requestId: "request-wake-plan",
              },
            ),
          );
          assert.equal(callback?.behavior, "deny");
          assert.include(
            callback?.behavior === "deny" ? callback.message : "",
            "The client captured your proposed plan",
          );
          yield* Queue.offer(harness.sdkMessages, planToolResult);
          yield* Queue.offer(harness.sdkMessages, wakeResult);
          yield* harness.awaitContinuation(1);

          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeAssistantTextFrame({
                uuid: "00000000-0000-4000-8000-000000000743",
                text: "USER_REPLY",
              }),
              1,
            ),
          );
          yield* Queue.offer(
            harness.sdkMessages,
            stamp(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000744",
                result: "USER_REPLY",
              }),
              1,
            ),
          );
          yield* harness.awaitTerminal(2);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: continuationAttempt,
              text: "Background task completed.",
              attachments: [],
              runtimePolicy,
              providerTurnOrdinal: 3,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.awaitTerminal(3);

          const latestItems = new Map(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated"
                ? [[String(event.turnItem.id), event.turnItem]]
                : [],
            ),
          );
          const planTool = [...latestItems.values()].find(
            (item) =>
              item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === planToolUseId,
          );
          const proposedPlans = [...latestItems.values()].filter(
            (item) => item.type === "proposed_plan",
          );
          const plans = harness.events.flatMap((event) =>
            event.type === "plan.updated" && event.plan.kind === "proposed_plan"
              ? [event.plan]
              : [],
          );
          const planToolRuns = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === planToolUseId &&
            event.turnItem.type === "dynamic_tool"
              ? [event.turnItem.runId]
              : [],
          );
          assert.isNotEmpty(planToolRuns);
          assert.isTrue(planToolRuns.every((runId) => runId === runOf(continuationAttempt)));
          assert.equal(planTool?.runId, runOf(continuationAttempt));
          assert.lengthOf(proposedPlans, 1);
          assert.equal(proposedPlans[0]?.runId, runOf(continuationAttempt));
          assert.isTrue(plans.length > 0);
          assert.isTrue(plans.every((plan) => plan.runId === runOf(continuationAttempt)));
          const userRunItems = [...latestItems.values()].filter(
            (item) => item.runId === runOf(userAttempt),
          );
          assert.deepEqual(
            userRunItems.map((item) => item.type),
            ["assistant_message"],
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
  it.effect("stores a Bash result's stdout and stderr as command output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-bash-output");
        const bashToolUseId = "toolu_01BashOutput";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Run it.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "assistant",
            message: {
              model: "claude-sonnet-4-6",
              id: "msg_bash_output",
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: bashToolUseId,
                  name: "Bash",
                  input: { command: "git status" },
                },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000790",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: bashToolUseId, content: "On branch main" },
              ],
            },
            parent_tool_use_id: null,
            uuid: "00000000-0000-4000-8000-000000000791",
            session_id: WAKE_NATIVE_SESSION,
            tool_use_result: {
              stdout: "On branch main",
              stderr: "warning: dirty",
              interrupted: false,
              isImage: false,
            },
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000792", result: "Done." }),
        );
        yield* harness.awaitTerminal(1);

        const bash = harness.events.findLast(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === bashToolUseId,
        );
        assert.equal(
          bash?.type === "turn_item.updated" && bash.turnItem.type === "command_execution"
            ? bash.turnItem.output
            : undefined,
          "On branch main\nwarning: dirty",
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
});
