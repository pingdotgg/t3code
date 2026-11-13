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
  WORKFLOW_TOOL_USE_ID,
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
  it.effect("marks a workflow coordinator's script prompt and leaves a subagent brief plain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const script =
          'export const meta = { name: "probe-wf", description: "Run the alpha workflow" };';
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-script-prompt"),
            text: "Run the workflow and an auditor.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(workflowToolUse);
        yield* harness.offerAndWait(claudeSdkFrame({ ...workflowTaskStarted, prompt: script }));
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001289", state: "start" }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-plain-auditor",
            description: "Audit recent commits",
            task_type: "local_agent",
            prompt: "Audit the last five commits.",
            uuid: "00000000-0000-4000-8000-000000001290",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const subagentPrompt = (nativeTaskId: string) => {
          const subagent = harness.events.flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.nativeTaskRef?.nativeId === nativeTaskId
              ? [event.subagent]
              : [],
          )[0];
          const message = threadMessages(harness.events, subagent?.childThreadId).find(
            (event) => event.message.role === "user",
          )?.message;
          const turnItem = harness.events.findLast(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "user_message" &&
              event.turnItem.messageId === message?.id,
          );
          return {
            text: message?.text,
            messageMark: message?.workflowScript,
            itemMark:
              turnItem?.type === "turn_item.updated" && turnItem.turnItem.type === "user_message"
                ? turnItem.turnItem.workflowScript
                : undefined,
          };
        };
        // The user message item lands after the subagent node, so wait on the item itself.
        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).length > 0 &&
            subagentPrompt(WORKFLOW_TASK_ID).itemMark !== undefined &&
            subagentPrompt("task-plain-auditor").itemMark !== undefined,
        );
        assert.deepEqual(subagentPrompt(WORKFLOW_TASK_ID), {
          text: script,
          messageMark: true,
          itemMark: true,
        });
        assert.deepEqual(subagentPrompt("task-plain-auditor"), {
          text: "Audit the last five commits.",
          messageMark: false,
          itemMark: false,
        });
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
  it.effect("stops only a live workflow task and waits for its stopped notification", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const stoppedTasks: Array<string> = [];
        let interrupted = false;
        let closed = false;
        const harness = yield* makeWorkflowHarnessWithOptions({
          stopTask: (taskId) =>
            Effect.sync(() => {
              stoppedTasks.push(taskId);
            }),
          interrupt: Effect.sync(() => {
            interrupted = true;
          }),
          close: () =>
            Effect.sync(() => {
              closed = true;
            }),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-workflow-stop"),
            text: "Run the workflow.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(workflowToolUse);
        yield* harness.offerAndWait(workflowTaskStarted);
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001100",
            state: "start",
          }),
        );
        let member = yield* Queue.take(harness.subagentReceipts);
        while (!member.subagent.nativeTaskRef?.nativeId?.endsWith(":agent:2")) {
          member = yield* Queue.take(harness.subagentReceipts);
        }
        const stopTask = harness.runtime.stopTask!;
        for (const taskId of ["missing-task", `${WORKFLOW_TASK_ID}:agent:1`]) {
          const exit = yield* stopTask({ providerThread: harness.providerThread, taskId }).pipe(
            Effect.exit,
          );
          assert.isTrue(Exit.isFailure(exit));
        }
        const wrongThread = {
          ...harness.providerThread,
          nativeThreadRef: {
            driver: harness.providerThread.driver,
            nativeId: "wrong-session",
            strength: "strong" as const,
          },
        };
        assert.isTrue(
          Exit.isFailure(
            yield* stopTask({
              providerThread: wrongThread,
              taskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit),
          ),
        );
        assert.deepEqual(stoppedTasks, []);
        yield* stopTask({ providerThread: harness.providerThread, taskId: WORKFLOW_TASK_ID });
        assert.deepEqual(stoppedTasks, [WORKFLOW_TASK_ID]);
        assert.isFalse(interrupted);
        assert.isFalse(closed);
        assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, "running");
        yield* harness.offerAndWait(
          workflowNotification({
            uuid: "00000000-0000-4000-8000-000000001101",
            status: "stopped",
          }),
        );
        member = yield* Queue.take(harness.subagentReceipts);
        while (!member.subagent.nativeTaskRef?.nativeId?.endsWith(":agent:2")) {
          member = yield* Queue.take(harness.subagentReceipts);
        }
        assert.equal(
          workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status,
          "cancelled",
        );
        for (const index of [1, 2]) {
          assert.equal(
            workflowMemberEvents(harness.events, index).at(-1)?.subagent.status,
            "cancelled",
          );
        }
        assert.isTrue(
          Exit.isFailure(
            yield* stopTask({
              providerThread: harness.providerThread,
              taskId: WORKFLOW_TASK_ID,
            }).pipe(Effect.exit),
          ),
        );
        assert.deepEqual(stoppedTasks, [WORKFLOW_TASK_ID]);
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
  it.effect("projects each workflow member as its own subagent thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const now = yield* DateTime.now;
        const coordinatorTurnItems = () =>
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "subagent" &&
              event.turnItem.nativeItemRef?.nativeId === WORKFLOW_TASK_ID,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-members"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({
          harness,
          snapshotUuid: "00000000-0000-4000-8000-000000001004",
          state: "queued",
        });

        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)?.subagent;
        const first = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        const second = workflowMemberEvents(harness.events, 2).at(-1)?.subagent;
        assert.equal(first?.status, "pending");
        assert.isNull(first?.startedAt);
        assert.equal(second?.status, "pending");
        assert.isNull(second?.startedAt);
        const coordinatorThread = harness.events.find(
          (event) =>
            event.type === "app_thread.created" &&
            event.appThread.id === coordinator?.childThreadId,
        );
        assert.equal(
          coordinatorThread?.type === "app_thread.created"
            ? coordinatorThread.appThread.title
            : null,
          "Workflow · probe-wf",
        );
        assert.equal(first?.title, "alpha:one");
        assert.equal(first?.prompt, "Reply with exactly: A1");
        assert.equal(first?.model, "claude-opus-5[1m]");
        assert.equal(first?.threadId, coordinator?.childThreadId);
        assert.equal(second?.threadId, coordinator?.childThreadId);
        assert.notEqual(first?.childThreadId, second?.childThreadId);

        assert.equal(
          harness.events.find(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "app_thread.created" }
            > => event.type === "app_thread.created" && event.appThread.id === first?.childThreadId,
          )?.appThread.title,
          "alpha:one",
        );
        const memberNodes = harness.events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "node.updated" }> =>
            event.type === "node.updated" &&
            event.node.nativeItemRef?.nativeId === first?.nativeTaskRef?.nativeId,
        );
        assert.deepEqual(
          memberNodes.map((event) => event.node.kind),
          ["subagent", "root_turn"],
        );
        assert.deepEqual(
          memberNodes.map((event) => [event.node.status, event.node.startedAt]),
          [
            ["pending", null],
            ["pending", null],
          ],
        );
        assert.deepEqual(
          threadMessages(harness.events, first?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1"],
        );
        assert.deepEqual(
          threadMessages(harness.events, second?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A2"],
        );

        yield* TestClock.adjust("60 seconds");
        const memberStartedAt = DateTime.add(now, { seconds: 30 });
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001007",
            state: "start",
            secondState: "queued",
            startedAt: DateTime.toEpochMillis(memberStartedAt),
          }),
        );
        let started = yield* Queue.take(harness.subagentReceipts);
        while (started.subagent.id !== first?.id || started.subagent.status !== "running") {
          started = yield* Queue.take(harness.subagentReceipts);
        }
        assert.deepEqual(started.subagent.startedAt, memberStartedAt);
        const startedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === first?.childThreadId,
        );
        assert.equal(
          startedRoot?.type === "node.updated" ? startedRoot.node.status : null,
          "running",
        );
        assert.deepEqual(
          startedRoot?.type === "node.updated" ? startedRoot.node.startedAt : null,
          memberStartedAt,
        );

        const turnItemsBeforeRepeat = coordinatorTurnItems().length;
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001005",
            state: "start",
            secondState: "queued",
          }),
        );
        yield* harness.until(() => coordinatorTurnItems().length > turnItemsBeforeRepeat);
        assert.lengthOf(workflowMemberEvents(harness.events, 1), 2);
        assert.lengthOf(workflowMemberEvents(harness.events, 2), 1);

        const firstThreadId = first?.childThreadId;
        const firstThreadEvents = () =>
          harness.events.filter(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "app_thread.created" }
            > => event.type === "app_thread.created" && event.appThread.id === firstThreadId,
          );
        const turnItemsBeforeMetadata = coordinatorTurnItems().length;
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001017",
            state: "start",
            secondState: "queued",
            label: "alpha:review",
            prompt: "Review the change",
            model: "claude-sonnet-4-6",
          }),
        );
        // The member's node and app thread pick up the metadata after the coordinator item.
        yield* harness.until(
          () =>
            coordinatorTurnItems().length > turnItemsBeforeMetadata &&
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.title === "alpha:review" &&
            firstThreadEvents().at(-1)?.appThread.title === "alpha:review",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.title,
          "alpha:review",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.prompt,
          "Review the change",
        );
        assert.equal(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.model,
          "claude-sonnet-4-6",
        );
        assert.equal(firstThreadEvents().at(-1)?.appThread.title, "alpha:review");
        assert.equal(
          firstThreadEvents().at(-1)?.appThread.modelSelection.model,
          "claude-sonnet-4-6",
        );
        assert.deepEqual(
          firstThreadEvents().at(-1)?.appThread.createdAt,
          firstThreadEvents()[0]?.appThread.createdAt,
        );
        assert.equal(
          threadMessages(harness.events, firstThreadId).at(-1)?.message.text,
          "Review the change",
        );

        yield* TestClock.adjust("10 seconds");
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001018",
            state: "done",
            secondState: "queued",
            omitResult: true,
          }),
        );
        let finished = yield* Queue.take(harness.subagentReceipts);
        while (finished.subagent.id !== first?.id || finished.subagent.status !== "completed") {
          finished = yield* Queue.take(harness.subagentReceipts);
        }
        const completedAt = finished.subagent.completedAt;
        assert.deepEqual(completedAt, DateTime.add(now, { seconds: 70 }));
        yield* TestClock.adjust("60 seconds");
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001019",
            state: "done",
            secondState: "queued",
          }),
        );
        let excerpt = yield* Queue.take(harness.subagentReceipts);
        while (excerpt.subagent.id !== first?.id || excerpt.subagent.result !== "A1 excerpt") {
          excerpt = yield* Queue.take(harness.subagentReceipts);
        }
        assert.deepEqual(excerpt.subagent.completedAt, completedAt);
        const finishedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === firstThreadId,
        );
        assert.deepEqual(
          finishedRoot?.type === "node.updated" ? finishedRoot.node.completedAt : undefined,
          completedAt,
        );

        yield* harness.offerAndWait(
          workflowNotification({ uuid: "00000000-0000-4000-8000-000000001008", status: "stopped" }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001006",
            result: "Launched the workflow.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const stopped = workflowMemberEvents(harness.events, 2).at(-1)?.subagent;
        assert.equal(stopped?.status, "cancelled");
        assert.isNull(stopped?.startedAt);
        const stoppedRoot = harness.events.findLast(
          (event) => event.type === "node.updated" && event.node.threadId === second?.childThreadId,
        );
        assert.equal(
          stoppedRoot?.type === "node.updated" ? stoppedRoot.node.status : null,
          "cancelled",
        );
        assert.isNull(
          stoppedRoot?.type === "node.updated" ? stoppedRoot.node.startedAt : undefined,
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
  it.effect("projects workflow member threads after resuming a restarted session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarnessWithOptions({
          subagentLaunchToolUseId: WORKFLOW_TOOL_USE_ID,
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-resume"),
            text: "Continue the workflow.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...workflowToolUse,
            message: {
              model: "claude-sonnet-4-6",
              content: [
                { type: "tool_use", id: "toolu-resume-workflow", name: "SendMessage", input: {} },
              ],
            },
          }),
        );
        yield* harness.offerAndWait(
          claudeSdkFrame({
            ...workflowTaskStarted,
            tool_use_id: "toolu-resume-workflow",
            prompt: "Continue the workflow.",
          }),
        );
        yield* harness.offerAndWait(workflowLaunchAck(harness.transcriptDir));
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001040", state: "start" }),
        );
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001041", result: "Resumed." }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const member = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)?.subagent;
        assert.isDefined(member);
        assert.equal(member?.status, "running");
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "app_thread.created" && event.appThread.id === member?.childThreadId,
          ),
        );
        assert.deepEqual(
          threadMessages(harness.events, member?.childThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1", "A1 from the transcript"],
        );
        assert.isDefined(coordinator?.childThreadId);
        const recoveredThreads = harness.events.filter(
          (event) =>
            event.type === "app_thread.created" &&
            event.appThread.id === coordinator?.childThreadId,
        );
        assert.lengthOf(recoveredThreads, 1);
        const recovered = recoveredThreads[0];
        assert.equal(recovered?.type, "app_thread.created");
        if (recovered?.type !== "app_thread.created") throw new Error("Expected recovered thread");
        assert.isTrue(recovered.createOnly);
        assert.deepEqual(recovered.appThread.lineage, {
          parentThreadId: harness.threadId,
          relationshipToParent: "subagent",
          rootThreadId: harness.threadId,
        });
        assert.equal(recovered.appThread.createdBy, "agent");
        assert.equal(recovered.appThread.creationSource, "provider");
        assert.isBelow(
          harness.events.indexOf(recovered),
          harness.events.findIndex(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.childThreadId === coordinator?.childThreadId,
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
});
