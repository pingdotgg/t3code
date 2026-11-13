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
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  WORKFLOW_TASK_ID,
  makeWorkflowHarnessWithOptions,
  makeWorkflowHarness,
  workflowToolUse,
  workflowTaskStarted,
  workflowLaunchAck,
  workflowSnapshot,
  workflowNotification,
  workflowCoordinatorEvents,
  workflowMemberEvents,
  threadMessages,
  launchWorkflow,
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
  it.effect.each([
    "root result",
    "resume after root result",
    "completion before buffered start",
  ] as const)("orders %s arriving during workflow transcript replay", (arrival) =>
    Effect.scoped(
      Effect.gen(function* () {
        const digestStarted = yield* Deferred.make<void>();
        const releaseDigest = yield* Deferred.make<void>();
        const liveFrameOffered = yield* Deferred.make<void>();
        let pauseDigest = false;
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarnessWithOptions({ close: Queue.shutdown });
          const taskId = "task-resumed-during-workflow-replay";
          const taskStart = (toolUseId: string, prompt: string, uuid: string) =>
            claudeSdkFrame({
              ...workflowTaskStarted,
              task_id: taskId,
              task_type: "local_agent",
              is_backgrounded: true,
              subagent_type: "general-purpose",
              spawn_depth: 1,
              workflow_name: undefined,
              tool_use_id: toolUseId,
              prompt,
              uuid,
            });
          const taskFinished = (toolUseId: string, summary: string, uuid: string) =>
            claudeSdkFrame({
              ...workflowNotification({ uuid, status: "completed" }),
              task_id: taskId,
              tool_use_id: toolUseId,
              summary,
            });
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-workflow-replay-launch"),
              text: "Run the workflow and a background subagent.",
              attachments: [],
            }),
          );
          yield* harness.offerAndWait(workflowToolUse);
          yield* harness.offerAndWait(workflowTaskStarted);
          yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000003001", state: "start" }),
          );
          if (arrival !== "completion before buffered start") {
            yield* harness.offerAndWait(
              taskStart("toolu-initial", "Initial work.", "00000000-0000-4000-8000-000000003002"),
            );
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000003003",
              result: "Launched both tasks.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000003004",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          if (arrival === "completion before buffered start") {
            yield* harness.offerAndWait(
              taskStart("toolu-initial", "Initial work.", "00000000-0000-4000-8000-000000003005"),
            );
          } else {
            yield* harness.offerAndWait(
              taskFinished(
                "toolu-initial",
                "Initial result.",
                "00000000-0000-4000-8000-000000003005",
              ),
            );
          }
          if (arrival === "root result") {
            yield* harness.offerAndWait(
              claudeSdkFrame({
                type: "system",
                subtype: "init",
                session_id: WAKE_NATIVE_SESSION,
                uuid: "00000000-0000-4000-8000-000000003006",
              }),
            );
          }
          pauseDigest = true;
          const replay = yield* harness.runtime
            .startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-continuation"),
                providerTurnOrdinal: 2,
                text: "Continue.",
                attachments: [],
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(digestStarted);
          const liveFrames = yield* Effect.gen(function* () {
            if (arrival === "completion before buffered start") {
              yield* harness.offerAndWait(
                taskFinished(
                  "toolu-initial",
                  "Initial result.",
                  "00000000-0000-4000-8000-000000003007",
                ),
                liveFrameOffered,
              );
              return;
            }
            yield* harness.offerAndWait(
              claudeSdkFrame({
                ...makeResultFrame({
                  uuid: "00000000-0000-4000-8000-000000003008",
                  result: "Native wake turn finished.",
                }),
                origin: { kind: "task-notification" },
                num_turns: 1,
              }),
              liveFrameOffered,
            );
            if (arrival === "resume after root result") {
              yield* harness.offerAndWait(
                claudeSdkFrame({
                  type: "system",
                  subtype: "init",
                  session_id: WAKE_NATIVE_SESSION,
                  uuid: "00000000-0000-4000-8000-000000003009",
                }),
              );
              yield* harness.offerAndWait(
                taskStart(
                  "toolu-latest",
                  "Latest live resume.",
                  "00000000-0000-4000-8000-000000003010",
                ),
              );
            }
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(liveFrameOffered);
          yield* Deferred.succeed(releaseDigest, undefined);
          yield* Fiber.join(replay);
          yield* Fiber.join(liveFrames);
          if (arrival === "resume after root result") {
            yield* Queue.take(harness.terminalReceipts);
            yield* Queue.take(harness.continuationReceipts);
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-resume-continuation"),
                providerTurnOrdinal: 3,
                text: "Continue.",
                attachments: [],
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          if (arrival !== "root result") {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000003011",
                result: "Workflow answer delivered.",
              }),
            );
          }
          yield* Queue.take(harness.terminalReceipts);
          const latest = harness.events
            .flatMap((event) =>
              event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === taskId
                ? [event.subagent]
                : [],
            )
            .at(-1);
          if (arrival === "resume after root result") {
            assert.equal(latest?.status, "running");
            assert.equal(latest?.prompt, "Latest live resume.");
            assert.isNull(latest?.result);
            assert.isTrue(yield* harness.hasPendingBackgroundWork);
          } else {
            assert.equal(latest?.status, "completed");
            assert.equal(latest?.result, "Initial result.");
            assert.isFalse(yield* harness.hasPendingBackgroundWork);
            assert.lengthOf(harness.continuationRequests, 1);
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-workflow-replay-next-user"),
                providerTurnOrdinal: 3,
                text: "Next task.",
                attachments: [],
              }),
            );
          }
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, () =>
            Effect.gen(function* () {
              if (pauseDigest) {
                pauseDigest = false;
                yield* Deferred.succeed(digestStarted, undefined);
                yield* Deferred.await(releaseDigest);
              }
            }),
          ),
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
  it.effect("preserves buffered workflow outcomes when interrupted during replay", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const digestStarted = yield* Deferred.make<void>();
        const releaseDigest = yield* Deferred.make<void>();
        let pauseDigest = false;
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarnessWithOptions({ close: Queue.shutdown });
          const secondTaskId = "task-workflow-buffered-completion";
          const secondToolUseId = "toolu-workflow-buffered-completion";
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-workflow-buffered-launch"),
              text: "Run both workflows.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({
            harness,
            snapshotUuid: "00000000-0000-4000-8000-000000003100",
          });
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowTaskStarted,
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
              uuid: "00000000-0000-4000-8000-000000003101",
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowSnapshot({
                uuid: "00000000-0000-4000-8000-000000003102",
                state: "start",
              }),
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
            }),
          );
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000003103",
              result: "Launched both workflows.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(
            workflowNotification({
              uuid: "00000000-0000-4000-8000-000000003104",
              status: "completed",
            }),
          );
          yield* Queue.take(harness.continuationReceipts);
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...workflowNotification({
                uuid: "00000000-0000-4000-8000-000000003105",
                status: "completed",
              }),
              task_id: secondTaskId,
              tool_use_id: secondToolUseId,
            }),
          );
          const continuationInput = makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-buffered-replay"),
            providerTurnOrdinal: 2,
            text: "Continue.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          });
          pauseDigest = true;
          const replay = yield* harness.runtime
            .startTurn(continuationInput)
            .pipe(Effect.forkScoped);
          yield* Deferred.await(digestStarted);
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${continuationInput.attemptId}`,
            }),
          });
          yield* Deferred.succeed(releaseDigest, undefined);
          yield* Fiber.join(replay);
          const second = harness.events
            .flatMap((event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === secondTaskId
                ? [event.subagent]
                : [],
            )
            .at(-1);
          assert.equal(second?.status, "completed");
          assert.equal(second?.result, "Workflow finished.");
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, () =>
            Effect.gen(function* () {
              if (pauseDigest) {
                pauseDigest = false;
                yield* Deferred.succeed(digestStarted, undefined);
                yield* Deferred.await(releaseDigest);
              }
            }),
          ),
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
  it.effect.each([
    ["api_error", false, false],
    ["aborted_streaming", false, false],
    ["api_error", true, false],
    ["api_error", false, true],
    ["aborted_streaming", false, true],
  ] as const)(
    "stops the run's live workflow after root result %s, continuation=%s, pending Stop=%s",
    ([terminalReason, continuation, pendingStop]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stoppedTasks: Array<string> = [];
          const stopRequested = yield* Deferred.make<void>();
          const harness = yield* makeWorkflowHarnessWithOptions({
            stopTask: (taskId) =>
              Effect.sync(() => void stoppedTasks.push(taskId)).pipe(
                Effect.andThen(Deferred.succeed(stopRequested, undefined)),
                Effect.asVoid,
              ),
          });
          const now = yield* DateTime.now;
          const turnInput = {
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-root-failure"),
            text: "Run the workflow.",
            attachments: [],
          };
          yield* harness.runtime.startTurn(makeClaudeTestTurnInput(turnInput));
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001050" });
          const stopping = pendingStop
            ? yield* harness.runtime.stopSubagent!({
                providerThread: harness.providerThread,
                nativeTaskId: WORKFLOW_TASK_ID,
              }).pipe(Effect.exit, Effect.forkScoped)
            : undefined;
          if (pendingStop) yield* Deferred.await(stopRequested);
          if (continuation) {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000001051",
                result: "Launched.",
              }),
            );
            yield* Queue.take(harness.terminalReceipts);
            yield* harness.offerAndWait(
              claudeSdkFrame({
                ...workflowTaskStarted,
                uuid: "00000000-0000-4000-8000-000000001052",
              }),
            );
          }
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001053",
              result: "Root turn ended.",
              terminalReason,
              isError: terminalReason === "api_error",
            }),
          );
          if (continuation) {
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                ...turnInput,
                attemptId: RunAttemptId.make("attempt-claude-workflow-root-failure-wake"),
                providerTurnOrdinal: 2,
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, terminalReason === "api_error" ? "failed" : "interrupted");
          assert.equal(terminal.threadDisposition, "reusable");
          const settled = terminalReason === "api_error" ? "failed" : "cancelled";
          assert.deepEqual(
            stoppedTasks,
            pendingStop ? [WORKFLOW_TASK_ID, WORKFLOW_TASK_ID] : [WORKFLOW_TASK_ID],
          );
          if (stopping !== undefined) {
            yield* TestClock.adjust("2 seconds");
            assert.isTrue(Exit.isFailure(yield* Fiber.join(stopping)));
            const retry = yield* harness.runtime.stopSubagent!({
              providerThread: harness.providerThread,
              nativeTaskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit, Effect.forkScoped);
            yield* TestClock.adjust("2 seconds");
            assert.isTrue(Exit.isFailure(yield* Fiber.join(retry)));
          }
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, settled);
          for (const index of [1, 2]) {
            assert.equal(
              workflowMemberEvents(harness.events, index).at(-1)?.subagent.status,
              settled,
            );
          }
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
  it.effect("clears workflow member metadata only after a successful transcript read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-metadata"),
            text: "Run the alpha workflow in the background.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(workflowToolUse);
        yield* harness.offerAndWait(workflowTaskStarted);
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001040", state: "done" }),
        );
        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]
              ?.effort === "xhigh",
        );
        let coordinator = workflowCoordinatorEvents(harness.events).at(-1)!.subagent;
        assert.equal(coordinator.workflow?.agents[0]?.speed, "standard");

        const transcriptPath = NodePath.join(harness.transcriptDir, "agent-a1.jsonl");
        NodeFS.renameSync(transcriptPath, `${transcriptPath}.saved`);
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001041",
            state: "done",
            label: "alpha:unreadable",
          }),
        );
        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]
              ?.label === "alpha:unreadable",
        );
        coordinator = workflowCoordinatorEvents(harness.events).at(-1)!.subagent;
        assert.equal(coordinator.workflow?.agents[0]?.effort, "xhigh");
        assert.equal(coordinator.workflow?.agents[0]?.speed, "standard");

        NodeFS.renameSync(`${transcriptPath}.saved`, transcriptPath);
        NodeFS.appendFileSync(
          transcriptPath,
          '{"type":"assistant","uuid":"wf-metadata-cleared","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_new","content":[{"type":"text","text":"New answer without metadata"}]}}\n',
        );
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001042",
            state: "done",
            label: "alpha:new-response",
          }),
        );
        yield* harness.until(() => {
          const member = workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow
            ?.agents[0];
          return (
            member?.label === "alpha:new-response" &&
            member.effort === undefined &&
            member.speed === undefined
          );
        });
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001043", result: "Done." }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const member = workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow
          ?.agents[0];
        assert.isUndefined(member?.effort);
        assert.isUndefined(member?.speed);
        const childThreadId = member?.childThreadId;
        assert.deepEqual(
          threadMessages(harness.events, childThreadId)
            .filter((event) => event.message.role === "assistant")
            .map((event) => event.message.text),
          ["A1 from the transcript", "New answer without metadata"],
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
