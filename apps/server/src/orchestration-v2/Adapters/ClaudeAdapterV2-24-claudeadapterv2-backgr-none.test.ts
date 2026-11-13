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
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  makeSubagentAssistantFrames,
  makeSubagentToolResultFrame,
  makeSubagentTaskStartedFrame,
  makeSubagentNotificationFrame,
  subagentRouting,
  makeStopFixture,
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
    ["", "none"],
    [" behind another subagent's start without one", "before"],
    [" when another subagent's start without one arrives between its frames", "between"],
  ] as const)(
    "keeps a subagent's frames in order when a late progress names its tool use while the root is idle%s",
    ([, otherStart]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const TASK_ID = "task-late-owner-idle";
          const TOOL_USE_ID = "toolu-late-owner-idle";
          const BASH = "toolu-late-owner-idle-bash";
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const bashStatuses = () =>
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`${event.turnItem.type}:${event.turnItem.status}`]
                : [],
            );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-late-owner-idle-1"),
              text: "Audit in the background.",
              attachments: [],
            }),
          );
          for (const frame of [
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: TASK_ID,
              description: "Audit recent commits",
              subagent_type: "general-purpose",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: "Audit the last five commits.",
              uuid: "00000000-0000-4000-8000-000000000a01",
              session_id: WAKE_NATIVE_SESSION,
            }),
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000a02",
              result: "Auditing in the background.",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitTerminal(1);

          const otherStartFrame = claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "task-late-owner-other",
            description: "Check the changelog",
            subagent_type: "general-purpose",
            is_backgrounded: true,
            task_type: "local_agent",
            prompt: "Check the changelog.",
            uuid: "00000000-0000-4000-8000-000000000a09",
            session_id: WAKE_NATIVE_SESSION,
          });
          const progressFrame = claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            tool_use_id: TOOL_USE_ID,
            description: "Reading the last commits",
            usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
            uuid: "00000000-0000-4000-8000-000000000a04",
            session_id: WAKE_NATIVE_SESSION,
          });
          const bashResultFrame = makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000a05",
            toolUseId: BASH,
          });
          for (const frame of [
            ...(otherStart === "before" ? [otherStartFrame] : []),
            ...makeSubagentAssistantFrames({
              parentToolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000a03",
              text: "First.",
              bashToolUseId: BASH,
            }),
            ...(otherStart === "between"
              ? [otherStartFrame, bashResultFrame, progressFrame]
              : [progressFrame, bashResultFrame]),
            ...makeSubagentAssistantFrames({
              parentToolUseId: TOOL_USE_ID,
              uuid: "00000000-0000-4000-8000-000000000a06",
              text: "Second.",
            }),
            makeSubagentNotificationFrame({
              taskId: TASK_ID,
              toolUseId: TOOL_USE_ID,
              summary: "Second.",
              uuid: "00000000-0000-4000-8000-000000000a07",
            }),
          ]) {
            yield* Queue.offer(harness.sdkMessages, frame);
          }
          yield* harness.awaitContinuation(1);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000a08",
              result: "The auditor finished.",
            }),
          );
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-late-owner-idle-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* harness.awaitTerminal(2);

          const routing = subagentRouting(harness.events, [BASH]);
          const childTexts = routing.assistantTexts(routing.childThreadId);
          const statuses = bashStatuses();
          const trace = harness.events.flatMap((event) =>
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.threadId === routing.childThreadId
              ? [`text:${event.message.text}#${event.message.id}`]
              : event.type === "turn_item.updated" &&
                  event.turnItem.nativeItemRef?.nativeId === BASH
                ? [`bash:${event.turnItem.status}`]
                : [],
          );
          assert.deepEqual(childTexts, ["First.", "Second."], `trace: ${JSON.stringify(trace)}`);
          assert.deepEqual(
            [...(routing.toolThreadIds.get(BASH) ?? [])],
            [routing.childThreadId],
            `trace: ${JSON.stringify(trace)}`,
          );
          assert.deepEqual(
            statuses,
            ["command_execution:running", "command_execution:completed"],
            `trace: ${JSON.stringify(trace)}`,
          );
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.progress === "Reading the last commits",
            ),
          );
          assert.lengthOf(harness.continuationRequests, 1);
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
  it.effect("holds subagent frames that precede task_started and shows its result once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const TASK_ID = "task-early-subagent";
        const TOOL_USE_ID = "toolu-early-subagent";
        const FINAL_REPORT = "Early auditor done.";
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-early-subagent"),
            text: "Run an auditor.",
            attachments: [],
          }),
        );
        const frames = [
          // Child frames can precede the task_started that registers their subagent.
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000321",
            text: "Starting early.",
            bashToolUseId: "toolu-early-bash",
          }),
          makeSubagentToolResultFrame({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000322",
            toolUseId: "toolu-early-bash",
          }),
          makeSubagentTaskStartedFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000323",
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000324",
            text: "Still working.",
          }),
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: TASK_ID,
            description: "Checking the diffs",
            uuid: "00000000-0000-4000-8000-000000000325",
            session_id: WAKE_NATIVE_SESSION,
          }),
          ...makeSubagentAssistantFrames({
            parentToolUseId: TOOL_USE_ID,
            uuid: "00000000-0000-4000-8000-000000000326",
            text: FINAL_REPORT,
          }),
          makeSubagentNotificationFrame({
            taskId: TASK_ID,
            toolUseId: TOOL_USE_ID,
            summary: FINAL_REPORT,
            uuid: "00000000-0000-4000-8000-000000000327",
          }),
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000328",
            result: "The auditor finished.",
          }),
        ];
        for (const frame of frames) {
          yield* Queue.offer(harness.sdkMessages, frame);
        }
        yield* harness.awaitTerminal(1);

        const routing = subagentRouting(harness.events, ["toolu-early-bash"]);
        assert.isDefined(routing.childThreadId);
        assert.deepEqual(
          [...(routing.toolThreadIds.get("toolu-early-bash") ?? [])],
          [routing.childThreadId],
        );
        assert.deepEqual(routing.assistantTexts(routing.childThreadId), [
          "Starting early.",
          "Still working.",
          FINAL_REPORT,
        ]);
        assert.deepEqual(routing.assistantTexts(harness.threadId), ["The auditor finished."]);
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
  it.effect.each([false, true])(
    "drops an idle start superseded by live completion, later resume %s",
    (resume) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const startTurn = (ordinal: number, continuation = false) =>
            harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: DateTime.makeUnsafe(0),
                attemptId: RunAttemptId.make(`attempt-stale-start-${ordinal}`),
                providerTurnOrdinal: ordinal,
                text: "Continue work.",
                attachments: [],
                ...(continuation
                  ? {
                      messageCreatedBy: "agent" as const,
                      messageCreationSource: "provider" as const,
                    }
                  : {}),
              }),
            );
          const started = (taskId: string, suffix: string) =>
            makeSubagentTaskStartedFrame({
              taskId,
              toolUseId: `toolu-${taskId}`,
              uuid: `00000000-0000-4000-8000-${suffix}`,
            });
          const finished = (taskId: string, suffix: string) =>
            makeSubagentNotificationFrame({
              taskId,
              toolUseId: `toolu-${taskId}`,
              summary: "Finished audit.",
              uuid: `00000000-0000-4000-8000-${suffix}`,
            });
          yield* startTurn(1);
          yield* harness.offerAndWait(started("stale-agent", "000000004001"));
          yield* harness.offerAndWait(started("wake-agent", "000000004002"));
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004003",
              result: "Agents launched.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          yield* harness.offerAndWait(started("stale-agent", "000000004004"));
          yield* startTurn(2);
          yield* harness.offerAndWait(finished("stale-agent", "000000004005"));
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004006",
              result: "User turn finished.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          if (resume) yield* harness.offerAndWait(started("stale-agent", "000000004007"));
          yield* harness.offerAndWait(finished("wake-agent", "000000004008"));
          yield* Queue.take(harness.continuationReceipts);
          yield* startTurn(3, true);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000004009",
              result: "Wake finished.",
            }),
          );
          yield* Queue.take(harness.terminalReceipts);
          const latest = harness.events.findLast(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.nativeTaskRef?.nativeId === "stale-agent",
          );
          assert.equal(latest?.type, "subagent.updated");
          if (latest?.type !== "subagent.updated") return;
          assert.equal(latest.subagent.status, resume ? "running" : "completed");
          assert.equal(latest.subagent.result, resume ? null : "Finished audit.");
          assert.equal(latest.subagent.completedAt === null, resume);
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
  it.effect("retains native confirmation after the synchronous Agent tool result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeStopFixture({
          stopTask: () => Effect.die("Task already completed"),
        });
        yield* fixture.notify("completed");
        const completed = yield* Queue.take(fixture.subagentReceipts);
        yield* fixture.offerAndWait(
          claudeSdkFrame({
            type: "user",
            message: {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: "toolu-stop-agent", content: "Tool result." },
              ],
            },
            parent_tool_use_id: null,
            uuid: fixture.uuid(),
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        assert.equal((yield* Queue.take(fixture.subagentReceipts)).subagent.result, "Tool result.");
        assert.deepEqual(yield* fixture.stop(), {
          status: "completed",
          completedAt: completed.subagent.completedAt!,
          result: "Native outcome.",
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
  it.effect.each([
    [false, "stopped"],
    [true, "stopped"],
    [false, "completed"],
  ] as const)(
    "stops one native subagent while its sibling keeps running, owner settled %s, outcome %s",
    ([ownerSettled, outcome]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const stopped: string[] = [];
          const stopRequested = yield* Deferred.make<void>();
          let closes = 0;
          const harness = yield* makeWakeHarnessWithOptions({
            stopTask: (taskId) =>
              Effect.sync(() => {
                stopped.push(taskId);
              }).pipe(Effect.andThen(Deferred.succeed(stopRequested, undefined))),
            interrupt: Effect.die("A child stop must not interrupt its owner"),
            close: () =>
              Effect.sync(() => {
                closes++;
              }),
          });
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-native-child-stop"),
              text: "Start two agents.",
              attachments: [],
            }),
          );
          for (const [taskId, toolUseId, uuid] of [
            ["agent-stop", "toolu-stop", "00000000-0000-4000-8000-000000000801"],
            ["agent-keep", "toolu-keep", "00000000-0000-4000-8000-000000000802"],
          ]) {
            yield* harness.offerAndWait(
              makeSubagentTaskStartedFrame({ taskId: taskId!, toolUseId: toolUseId!, uuid: uuid! }),
            );
            yield* Queue.take(harness.subagentReceipts);
          }
          if (ownerSettled) {
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000803",
                result: "Agents are working.",
              }),
            );
            yield* Queue.take(harness.terminalReceipts);
          }
          const stop = harness.runtime.stopSubagent;
          assert.isDefined(stop);
          const stopping = yield* stop!({
            providerThread: harness.providerThread,
            nativeTaskId: "agent-stop",
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(stopRequested);
          assert.deepEqual(stopped, ["agent-stop"]);
          yield* harness.offerAndWait(
            claudeSdkFrame({
              ...makeSubagentNotificationFrame({
                taskId: "agent-stop",
                toolUseId: "toolu-stop",
                summary: "Stopped by user",
                uuid: "00000000-0000-4000-8000-000000000804",
              }),
              status: outcome,
            }),
          );
          if (ownerSettled) {
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-native-child-stop-wake"),
                text: "Background task stopped.",
                attachments: [],
                providerTurnOrdinal: 2,
                messageCreatedBy: "agent",
                messageCreationSource: "provider",
              }),
            );
          }
          yield* Fiber.join(stopping);
          const stoppedEvent = yield* Queue.take(harness.subagentReceipts);
          assert.equal(
            stoppedEvent.subagent.status,
            outcome === "stopped" ? "cancelled" : "completed",
          );
          const tasks = harness.events.filter((event) => event.type === "subagent.updated");
          assert.equal(
            tasks.findLast((event) => event.subagent.nativeTaskRef?.nativeId === "agent-stop")
              ?.subagent.status,
            outcome === "stopped" ? "cancelled" : "completed",
          );
          assert.equal(
            tasks.findLast((event) => event.subagent.nativeTaskRef?.nativeId === "agent-keep")
              ?.subagent.status,
            "running",
          );
          assert.lengthOf(harness.terminalEvents(), ownerSettled ? 1 : 0);
          yield* stop!({ providerThread: harness.providerThread, nativeTaskId: "agent-stop" });
          assert.deepEqual(stopped, ["agent-stop"]);
          assert.equal(closes, 0);
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
