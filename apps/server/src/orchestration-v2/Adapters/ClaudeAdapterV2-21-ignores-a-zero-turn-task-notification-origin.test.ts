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
  WAKE_RESULT_TEXT,
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeAssistantErrorFrame,
  makeResultFrame,
  wakeAssistant,
  wakeTurnInit,
  wakeResult,
  STALE_TASK_NOTIFICATION_RESULT_TEXT,
  staleTaskNotificationResult,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  makeSubagentTaskStartedFrame,
  makeSubagentNotificationFrame,
  stopRacedByReplacementTurn,
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
  it.effect("ignores a zero-turn task-notification origin result during a normal user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const probeAssistantText = "Probe after stale task-notification result.";
        const recoveryAssistantText = "Recovered after the interrupt; continuing.";
        const staleResultText = STALE_TASK_NOTIFICATION_RESULT_TEXT;
        const hasMessageText = (text: string) =>
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === text,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-stale-notif-1"),
            text: "Continue after interrupt.",
            attachments: [],
          }),
        );
        yield* harness.until(() => harness.offeredMessages.length === 1);

        // After interrupt recovery, stale task notifications and their results can precede the root stream.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: "task-stale-stopped",
            tool_use_id: "toolu-stale-stopped",
            status: "stopped",
            output_file: "/tmp/task-stale-stopped.log",
            summary: "",
            uuid: "00000000-0000-4000-8000-000000000107",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, staleTaskNotificationResult);
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-00000000010a",
            text: probeAssistantText,
          }),
        );

        yield* harness.until(() => hasMessageText(probeAssistantText));
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.isFalse(hasMessageText(staleResultText));

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000108",
            text: recoveryAssistantText,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000109",
            result: recoveryAssistantText,
          }),
        );

        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(hasMessageText(recoveryAssistantText));
        assert.isFalse(hasMessageText(staleResultText));
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
    "emits one interrupted terminal for a positive task-notification result racing interrupt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const closeGate = yield* Deferred.make<void>();
          const testScope = yield* Scope.Scope;
          yield* Scope.addFinalizer(testScope, Deferred.succeed(closeGate, undefined));
          const interruptStarted = yield* Deferred.make<void>();
          const harness = yield* makeWakeHarnessWithOptions({
            close: (sdkMessages) =>
              Deferred.await(closeGate).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
            stopTask: () => Effect.void,
            interrupt: Deferred.succeed(interruptStarted, undefined),
          });
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const now = yield* DateTime.now;
          const attemptId = RunAttemptId.make("attempt-claude-interrupt-positive-notif");
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId,
              text: "Stop this task.",
              attachments: [],
            }),
          );
          yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(interruptStarted);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000115",
              result: "Late result after interrupt.",
              numTurns: 7,
              origin: { kind: "task-notification" },
            }),
          );
          const terminalized = Exit.isSuccess(yield* harness.awaitTerminal(1).pipe(Effect.exit));
          yield* Deferred.succeed(closeGate, undefined);
          assert.isTrue(terminalized);
          assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
          assert.lengthOf(harness.terminalEvents(), 1);
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
  it.effect("settles a continuation turn immediately when no wake output is buffered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-3"),
            text: "Background task completed.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );

        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 0);
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
    { label: "an empty one", quotaFailureFirst: false },
    { label: "a quota failure and an empty one", quotaFailureFirst: true },
  ])(
    "keeps the wake run open for the turn Claude opens right after $label",
    ({ quotaFailureFirst }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const subagents = [
            { taskId: "task-wake-pair-a", toolUseId: "toolu_wake_pair_a" },
            { taskId: "task-wake-pair-b", toolUseId: "toolu_wake_pair_b" },
          ];
          const wakeAttempt = RunAttemptId.make("attempt-claude-wake-pair-2");

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-pair-1"),
              text: "Audit both in the background.",
              attachments: [],
            }),
          );
          for (const [index, subagent] of subagents.entries()) {
            yield* Queue.offer(
              harness.sdkMessages,
              makeSubagentTaskStartedFrame({
                ...subagent,
                uuid: `00000000-0000-4000-8000-00000000095${index}`,
              }),
            );
          }
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000952", result: "Started." }),
          );
          yield* harness.awaitTerminal(1);

          // Both subagents end together. Claude runs an empty turn for the first
          // notification and opens the real one a millisecond later, all before
          // the wake run attaches.
          for (const [index, subagent] of subagents.entries()) {
            yield* Queue.offer(
              harness.sdkMessages,
              makeSubagentNotificationFrame({
                ...subagent,
                summary: "AUDITED",
                uuid: `00000000-0000-4000-8000-00000000096${index}`,
              }),
            );
          }
          // A rejected wake that precedes the empty turn still must not settle
          // the run the live turn owns.
          if (quotaFailureFirst) {
            yield* harness.offerAndWait(
              makeAssistantErrorFrame({
                uuid: "00000000-0000-4000-8000-000000000964",
                error: "rate_limit",
              }),
            );
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000965",
                result: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
                isError: true,
                apiErrorStatus: 429,
                terminalReason: "api_error",
                origin: { kind: "task-notification" },
              }),
            );
          }
          yield* Queue.offer(harness.sdkMessages, wakeTurnInit);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000962",
              result: "",
              numTurns: 0,
              origin: { kind: "task-notification" },
              terminalReason: null,
            }),
          );
          yield* harness.offerAndWait(
            claudeSdkFrame({ ...wakeTurnInit, uuid: "00000000-0000-4000-8000-000000000963" }),
          );
          assert.lengthOf(harness.continuationRequests, 1);

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: wakeAttempt,
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          // Claude is still thinking, so the run stays working rather than
          // settling with nothing to show.
          assert.lengthOf(harness.terminalEvents(), 1);

          yield* harness.offerAndWait(wakeAssistant);
          yield* harness.offerAndWait(wakeResult);
          yield* harness.awaitTerminal(2);
          assert.equal(harness.terminalEvents()[1]?.status, "completed");
          assert.lengthOf(harness.continuationRequests, 1);
          assert.isTrue(
            harness.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.runId === RunId.make(`run-${wakeAttempt}`) &&
                event.message.text === WAKE_RESULT_TEXT,
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

  // A Stop closes the first process, and a turn replaces it before its stream ends.
  it.effect("ends a subagent whose process a Stop closed while a new turn replaced it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { processQueues, changes, terminals, subagentStatus, exitFirstProcess } =
          yield* stopRacedByReplacementTurn("raced-stop-replacement-close");
        yield* exitFirstProcess;
        // The replacement's result follows the stopped process's exit on the event stream.
        yield* Queue.offer(
          processQueues[1]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000002803",
            result: "Resumed.",
          }),
        );
        yield* changes.until(() => terminals().length === 2);

        assert.strictEqual(
          subagentStatus("raced-agent"),
          "cancelled",
          "the Stop ended the subagent's process, but the subagent is not cancelled",
        );
        assert.strictEqual(
          subagentStatus("own-agent"),
          "running",
          "the replacement process still runs its own subagent",
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

  // regression: #28331 Stop must clear a subagent whose process is gone
  it.effect("stops a subagent whose process a Stop closed while a new turn replaced it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, providerThread, exitFirstProcess } = yield* stopRacedByReplacementTurn(
          "raced-stop-replacement-stop-subagent",
        );
        yield* exitFirstProcess;
        const stopped = yield* runtime.stopSubagent!({
          providerThread: { ...providerThread, status: "active" },
          nativeTaskId: "raced-agent",
        }).pipe(
          Effect.map((outcome) => outcome?.status ?? "no outcome"),
          Effect.catch((error) =>
            Effect.succeed(`refused: ${"detail" in error ? error.detail : error.message}`),
          ),
        );

        assert.strictEqual(stopped, "cancelled", "Stop of a subagent whose process is gone");
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

  // regression: #28331 a process that exits late ends only the subagents it ran
  it.effect("leaves a stopping replacement's subagent to that replacement's exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const {
          runtime,
          threadId,
          providerThread,
          processQueues,
          closeRequested,
          changes,
          terminals,
          subagentStatus,
          exitFirstProcess,
          exitProcess,
          now,
        } = yield* stopRacedByReplacementTurn("raced-stop-replacement-chain");
        const activeThread = { ...providerThread, status: "active" as const };
        const finishTurn = (index: number, turns: number, uuid: string) =>
          Queue.offer(processQueues[index]!, makeResultFrame({ uuid, result: "Done." })).pipe(
            Effect.andThen(changes.until(() => terminals().length === turns)),
          );
        const startTurn = (label: string, providerTurnOrdinal: number) =>
          runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: activeThread,
              now,
              attemptId: RunAttemptId.make(`attempt-claude-raced-stop-replacement-chain-${label}`),
              text: "Carry on.",
              attachments: [],
              providerTurnOrdinal,
            }),
          );

        yield* finishTurn(1, 2, "00000000-0000-4000-8000-000000002805");
        const stopSecond = yield* runtime
          .interruptTurn({
            providerThread: activeThread,
            providerTurnId: terminals()[1]!.providerTurnId,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(closeRequested[1]!);
        yield* startTurn("c", 3);
        assert.lengthOf(processQueues, 3);

        yield* exitFirstProcess;
        yield* finishTurn(2, 3, "00000000-0000-4000-8000-000000002806");
        assert.strictEqual(
          subagentStatus("raced-agent"),
          "cancelled",
          "the first process exited after a Stop, but its subagent is not cancelled",
        );
        assert.strictEqual(
          subagentStatus("own-agent"),
          "running",
          "the first process ended a subagent the second process still ran",
        );

        yield* exitProcess(1, stopSecond);
        yield* startTurn("d", 4);
        yield* finishTurn(2, 4, "00000000-0000-4000-8000-000000002807");
        assert.strictEqual(
          subagentStatus("own-agent"),
          "cancelled",
          "the second process exited after a Stop, but its subagent is not cancelled",
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
