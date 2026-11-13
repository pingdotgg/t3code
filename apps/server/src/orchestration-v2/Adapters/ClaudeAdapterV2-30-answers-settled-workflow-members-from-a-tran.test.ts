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
  makeResultFrame,
  makeWorkflowHarness,
  workflowSnapshot,
  workflowNotification,
  workflowCoordinatorEvents,
  workflowMemberEvents,
  threadMessages,
  launchWorkflow,
  memberAssistantLine,
  memberToolResultLine,
  memberTranscript,
  memberThreadItems,
  latestMemberThreadItems,
  describeItem,
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
  it.effect("answers settled workflow members from a transcript, or the snapshot excerpt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-settled"),
            text: "Run the alpha workflow in the background.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001007" });
        const firstThreadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        const secondThreadId = workflowMemberEvents(harness.events, 2)[0]?.subagent.childThreadId;
        const currentAssistantAnswers = () => [
          ...new Map(
            threadMessages(harness.events, firstThreadId)
              .filter((event) => event.message.role === "assistant")
              .map((event) => [event.message.id, event.message.text]),
          ).values(),
        ];
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001008",
            result: "Launched the workflow.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-unrelated-failure"),
            text: "Do another task.",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000001014",
            result: "Another task failed.",
            terminalReason: "api_error",
            isError: true,
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.equal(workflowCoordinatorEvents(harness.events).at(-1)?.subagent.status, "running");
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");

        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001009", state: "done" }),
        );
        yield* harness.until(() => threadMessages(harness.events, secondThreadId).length === 2);

        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]
              ?.effort === "xhigh",
        );
        const coordinator = workflowCoordinatorEvents(harness.events).at(-1)!.subagent;
        assert.deepEqual(
          coordinator.workflow?.agents.map((member) => member.state),
          ["completed", "completed"],
        );
        assert.equal(coordinator.workflow?.agents[0]?.speed, "standard");
        assert.isUndefined(coordinator.workflow?.agents[1]?.effort);
        assert.isUndefined(coordinator.workflow?.agents[1]?.speed);
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "completed");
        assert.equal(workflowMemberEvents(harness.events, 2).at(-1)?.subagent.status, "completed");
        assert.deepEqual(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.completedAt,
          yield* DateTime.now,
        );
        assert.deepEqual(
          threadMessages(harness.events, firstThreadId).map((event) => event.message.text),
          ["Reply with exactly: A1", "A1 from the transcript"],
        );
        assert.deepEqual(
          threadMessages(harness.events, secondThreadId).map((event) => event.message.text),
          ["Reply with exactly: A2", "Partial answer from workflow progress:\n\nA2 excerpt"],
        );
        const coordinatorEventsBeforeRepeat = workflowCoordinatorEvents(harness.events).length;
        const memberEventsBeforeRepeat = workflowMemberEvents(harness.events, 2).length;
        NodeFS.appendFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          '{"type":"assistant","uuid":"wf-line-4","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a1","content":[{"type":"text","text":"A1 continued"}]}}\n',
        );
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001015", state: "done" }),
        );
        yield* harness.until(
          () => workflowCoordinatorEvents(harness.events).length > coordinatorEventsBeforeRepeat,
        );
        yield* harness.until(
          () =>
            threadMessages(harness.events, firstThreadId).at(-1)?.message.text === "A1 continued",
        );
        assert.lengthOf(workflowMemberEvents(harness.events, 2), memberEventsBeforeRepeat);
        assert.lengthOf(threadMessages(harness.events, secondThreadId), 2);
        assert.deepEqual(currentAssistantAnswers(), ["A1 from the transcript", "A1 continued"]);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a2.jsonl"),
          '{"type":"assistant","uuid":"wf-line-5","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_a2","content":[{"type":"text","text":"A2 from the transcript"}]}}\n',
        );
        yield* harness.offerAndWait(
          workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001016", state: "done" }),
        );
        yield* harness.until(() => threadMessages(harness.events, secondThreadId).length === 3);
        assert.lengthOf(workflowMemberEvents(harness.events, 2), memberEventsBeforeRepeat);
        assert.equal(
          threadMessages(harness.events, secondThreadId).at(-1)?.message.text,
          "A2 from the transcript",
        );
        const previousStartedAt = workflowMemberEvents(harness.events, 1).at(-1)?.subagent
          .startedAt;
        yield* TestClock.adjust(1_000);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          [
            '{"type":"assistant","uuid":"wf-line-6","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_first","content":[{"type":"text","text":"First answer"}]}}',
            '{"type":"assistant","uuid":"wf-line-7","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_second","content":[{"type":"text","text":"Second answer"}]}}',
          ].join("\n") + "\n",
        );
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001018",
            state: "done",
            attempt: 2,
            startedAt: 1000,
            durationMs: 500,
            lastProgressAt: 4432,
          }),
        );
        yield* harness.until(() =>
          currentAssistantAnswers().join("\n\n").includes("Second answer"),
        );
        assert.deepEqual(currentAssistantAnswers().slice(-2), ["First answer", "Second answer"]);
        const completedMember = workflowMemberEvents(harness.events, 1).at(-1)?.subagent;
        assert.equal(
          completedMember?.completedAt && DateTime.toEpochMillis(completedMember.completedAt),
          4432,
        );
        assert.isUndefined(
          workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]?.effort,
        );
        assert.isUndefined(
          workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]?.speed,
        );
        assert.notDeepEqual(
          workflowMemberEvents(harness.events, 1).at(-1)?.subagent.startedAt,
          previousStartedAt,
        );
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001019",
            state: "start",
            attempt: 3,
          }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "running");
        assert.isNull(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.completedAt);
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001020",
            state: "start",
            attempt: 3,
          }),
        );
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          '{"type":"assistant","uuid":"wf-line-8","message":{"role":"assistant","stop_reason":"end_turn","id":"msg_retry","content":[{"type":"text","text":"A1 retry answer"}]}}\n',
        );
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001021",
            state: "done",
            attempt: 3,
          }),
        );
        yield* harness.until(
          () =>
            threadMessages(harness.events, firstThreadId).at(-1)?.message.text ===
            "A1 retry answer",
        );
        assert.equal(currentAssistantAnswers().at(-1), "A1 retry answer");
        NodeFS.rmSync(NodePath.join(harness.transcriptDir, "agent-a1.jsonl"));
        yield* Queue.offer(
          harness.sdkMessages,
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001022",
            state: "start",
            attempt: 4,
          }),
        );
        yield* harness.until(
          () =>
            workflowCoordinatorEvents(harness.events).at(-1)?.subagent.workflow?.agents[0]
              ?.attempt === 4,
        );
        const answersBeforeEmptyAttempt = currentAssistantAnswers();
        yield* harness.offerAndWait(
          workflowSnapshot({
            uuid: "00000000-0000-4000-8000-000000001023",
            state: "done",
            attempt: 4,
            omitResult: true,
          }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "completed");
        assert.deepEqual(
          currentAssistantAnswers(),
          answersBeforeEmptyAttempt,
          "an attempt with no transcript and no excerpt adds nothing",
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
  it.effect("streams a running workflow member's conversation from its transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reads: Array<{
          readonly startOffset: number;
          readonly endOffset: number;
          readonly lineCount: number;
        }> = [];
        yield* Effect.gen(function* () {
          const harness = yield* makeWorkflowHarness;
          const transcriptPath = NodePath.join(harness.transcriptDir, "agent-a1.jsonl");
          NodeFS.writeFileSync(transcriptPath, memberTranscript);
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-claude-workflow-live-stream"),
              text: "Run the alpha workflow.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001360" });
          const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
          const running = (uuid: string) => workflowSnapshot({ uuid, state: "start" });

          assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
            "user_message",
            "reasoning: List the files first.",
            "command completed: README.md",
            "assistant_message",
          ]);
          assert.deepEqual(
            threadMessages(harness.events, threadId).map((event) => event.message.text),
            ["Reply with exactly: A1", "A1 found README.md"],
          );
          assert.deepEqual(reads.at(-1), {
            startOffset: 0,
            endOffset: Buffer.byteLength(memberTranscript),
            lineCount: 5,
          });

          const itemsBefore = memberThreadItems(harness.events, threadId).length;
          const more = memberAssistantLine("line-more", "msg_a1_more", [
            {
              type: "tool_use",
              id: "toolu_a1_cat",
              name: "Bash",
              input: { command: "cat README.md" },
            },
          ]);
          const half = memberToolResultLine("line-cat-result", "toolu_a1_cat", "hello");
          NodeFS.appendFileSync(transcriptPath, more + half.slice(0, 40));
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001361"));
          assert.deepEqual(reads.at(-1), {
            startOffset: Buffer.byteLength(memberTranscript),
            endOffset: Buffer.byteLength(memberTranscript + more),
            lineCount: 1,
          });
          assert.deepEqual(
            memberThreadItems(harness.events, threadId).slice(itemsBefore).map(describeItem),
            ["command running: "],
            "only the new line is projected; the half-written one waits",
          );

          NodeFS.appendFileSync(transcriptPath, half.slice(40));
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001362"));
          assert.deepEqual(reads.at(-1), {
            startOffset: Buffer.byteLength(memberTranscript + more),
            endOffset: Buffer.byteLength(memberTranscript + more + half),
            lineCount: 1,
          });
          assert.deepEqual(
            memberThreadItems(harness.events, threadId).slice(itemsBefore).map(describeItem),
            ["command running: ", "command completed: hello"],
          );

          const itemsBeforeIdle = memberThreadItems(harness.events, threadId).length;
          yield* harness.offerAndWait(running("00000000-0000-4000-8000-000000001363"));
          assert.equal(reads.at(-1)?.lineCount, 0);
          assert.lengthOf(memberThreadItems(harness.events, threadId), itemsBeforeIdle);

          yield* harness.offerAndWait(
            workflowSnapshot({ uuid: "00000000-0000-4000-8000-000000001364", state: "done" }),
          );
          assert.equal(
            workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status,
            "completed",
          );
          assert.deepEqual(
            threadMessages(harness.events, threadId).map((event) => event.message.text),
            ["Reply with exactly: A1", "A1 found README.md"],
            "the settled member adds no second copy of its answer",
          );
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001365", result: "Done." }),
          );
          yield* Queue.take(harness.terminalReceipts);
        }).pipe(
          Effect.provideService(WorkflowAgentTranscriptReadObserver, (read) =>
            Effect.sync(() => {
              if (read.agentId === "a1") {
                reads.push({
                  startOffset: read.startOffset,
                  endOffset: read.endOffset,
                  lineCount: read.lineCount,
                });
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
  it.effect("interrupts the open tool calls of a workflow member that failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          memberAssistantLine("line-bash", "msg_a1", [
            { type: "tool_use", id: "toolu_a1_ls", name: "Bash", input: { command: "ls" } },
          ]),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-member-fails"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001370" });
        const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
          "user_message",
          "command running: ",
        ]);
        yield* harness.offerAndWait(
          workflowNotification({ uuid: "00000000-0000-4000-8000-000000001371", status: "failed" }),
        );
        assert.equal(workflowMemberEvents(harness.events, 1).at(-1)?.subagent.status, "failed");
        assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
          "user_message",
          "command interrupted: ",
        ]);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001372", result: "Done." }),
        );
        yield* Queue.take(harness.terminalReceipts);
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
  it.effect("reads a settled workflow member's transcript to its end past the read cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWorkflowHarness;
        // Exceeds the launch and settle reads combined, at 512 KB each.
        const filler = "x".repeat(16 * 1024);
        NodeFS.writeFileSync(
          NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
          Array.from({ length: 80 }, (_, index) =>
            memberAssistantLine(`line-early-${index}`, `msg_early_${index}`, [
              { type: "text", text: `${index} ${filler}` },
            ]),
          ).join("") +
            memberAssistantLine("line-final", "msg_final", [
              { type: "text", text: "FINAL ANSWER" },
            ]),
        );
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-workflow-member-long-transcript"),
            text: "Run the alpha workflow.",
            attachments: [],
          }),
        );
        yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001390" });
        const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
        yield* harness.offerAndWait(
          workflowNotification({
            uuid: "00000000-0000-4000-8000-000000001391",
            status: "completed",
          }),
        );
        const texts = threadMessages(harness.events, threadId)
          .filter((event) => event.message.role === "assistant")
          .map((event) => event.message.text);
        assert.lengthOf(texts, 81);
        assert.equal(texts.at(-1), "FINAL ANSWER", "the answer past the first read is shown");
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001392", result: "Done." }),
        );
        yield* Queue.take(harness.terminalReceipts);
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
  it.effect("re-reads a workflow member's transcript after a restart without new items", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runOnce = Effect.fnUntraced(function* (attemptId: string) {
          const harness = yield* makeWorkflowHarness;
          NodeFS.writeFileSync(
            NodePath.join(harness.transcriptDir, "agent-a1.jsonl"),
            memberTranscript,
          );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(attemptId),
              text: "Run the alpha workflow.",
              attachments: [],
            }),
          );
          yield* launchWorkflow({ harness, snapshotUuid: "00000000-0000-4000-8000-000000001380" });
          const threadId = workflowMemberEvents(harness.events, 1)[0]?.subagent.childThreadId;
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000001381", result: "Done." }),
          );
          yield* Queue.take(harness.terminalReceipts);
          assert.deepEqual(latestMemberThreadItems(harness.events, threadId).map(describeItem), [
            "user_message",
            "reasoning: List the files first.",
            "command completed: README.md",
            "assistant_message",
          ]);
          return new Set(memberThreadItems(harness.events, threadId).map((item) => item.id));
        });
        const before = yield* runOnce("attempt-claude-workflow-before-restart");
        const after = yield* runOnce("attempt-claude-workflow-after-restart");
        assert.isAtLeast(before.size, 4);
        assert.deepEqual(
          [...after].filter((id) => !before.has(id)),
          [],
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
