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
  WAKE_TASK_ID,
  WAKE_SUMMARY,
  WAKE_ASSISTANT_TEXT,
  WAKE_RESULT_TEXT,
  claudeSdkFrame,
  wakeTaskStarted,
  makeAssistantErrorFrame,
  makeResultFrame,
  turnOneResult,
  wakeNotification,
  wakeAssistant,
  wakeTurnInit,
  wakeResult,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
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
  it.effect("runs a follow-up in a fresh query while the mod-blocked query is closing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const releaseClose = yield* Deferred.make<void>();
        const replacementClosedOld = yield* Deferred.make<void>();
        let oldCloses = 0;
        const harness = yield* makeWakeHarnessWithOptions({
          // The held CLI never answers an interrupt; closure must not need one.
          interrupt: Effect.never,
          close: (sdkMessages) =>
            Effect.suspend(() =>
              ++oldCloses === 2 ? Deferred.succeed(replacementClosedOld, undefined) : Effect.void,
            ).pipe(
              Effect.andThen(Deferred.await(releaseClose)),
              Effect.andThen(Queue.shutdown(sdkMessages)),
            ),
          freshQueueOnReopen: true,
        });
        // Added after the harness so it runs first: a failed assertion must not
        // leave teardown waiting on the held close.
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseClose, undefined));
        const now = yield* DateTime.now;
        const turnInput = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-mod-pane-blocked"),
          text: "Run rm -r build",
          attachments: [],
        });
        yield* harness.runtime.startTurn(turnInput);
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "ui_panes",
            panes: [
              { id: "blast-radius", title: "Blast Radius", plugin: "blast-radius", rows: 10 },
            ],
            shown_id: "blast-radius",
            focused_id: null,
            focus_requested_id: "blast-radius",
            uuid: "00000000-0000-4000-8000-000000000798",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "failed");

        const followUp = yield* harness.runtime
          .startTurn({
            ...turnInput,
            attemptId: RunAttemptId.make("attempt-claude-after-mod-pane"),
            providerTurnOrdinal: 2,
          })
          .pipe(Effect.forkScoped);
        // Reusing the closing process would offer the prompt to it instead.
        yield* Effect.raceFirst(
          Deferred.await(replacementClosedOld),
          harness.until(() => harness.offeredMessages.length >= 2),
        );
        assert.isTrue(yield* Deferred.isDone(replacementClosedOld));
        yield* Deferred.succeed(releaseClose, undefined);
        yield* Fiber.join(followUp);
        assert.equal(harness.processQueues.length, 2);
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "after-mod-pane-result", result: "Done." }),
        );
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
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

  // regression: #16897 a prompt whose uuid the session already holds must not hang or end early
  it.effect("keeps a started prompt running until its result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-started-prompt"),
            text: "Bump this PR to the latest main.",
            attachments: [],
          }),
        );
        const lifecycle = (state: string, uuid: string) =>
          claudeSdkFrame({
            type: "command_lifecycle",
            command_uuid: harness.promptUuid(0),
            state,
            uuid,
            session_id: WAKE_NATIVE_SESSION,
          });
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("queued", "00000000-0000-4000-8000-000000000791"),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("started", "00000000-0000-4000-8000-000000000792"),
        );
        // The CLI can report the prompt completed before its turn's result.
        yield* Queue.offer(
          harness.sdkMessages,
          lifecycle("completed", "00000000-0000-4000-8000-000000000793"),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            ...makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000794", result: "Done." }),
            user_message_uuid: harness.promptUuid(0),
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
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
  it.effect("buffers wake output and requests a single continuation run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        yield* harness.offerAndWait(wakeNotification);
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, wakeAssistant);
        yield* harness.awaitContinuation(1);
        assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
        assert.equal(harness.continuationRequests[0]?.providerThreadId, harness.providerThread.id);
        assert.equal(harness.continuationRequests[0]?.driver, ClaudeAdapterV2.CLAUDE_PROVIDER);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

        yield* harness.offerAndWait(wakeResult);
        assert.lengthOf(harness.continuationRequests, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
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
  it.effect("starts the wake run when Claude opens the wake turn, before its output", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-init-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);

        yield* harness.offerAndWait(wakeNotification);
        assert.lengthOf(harness.continuationRequests, 0);
        yield* harness.offerAndWait(wakeTurnInit);
        assert.lengthOf(harness.continuationRequests, 1);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-init-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        assert.lengthOf(harness.terminalEvents(), 1);

        yield* harness.offerAndWait(wakeAssistant);
        yield* harness.offerAndWait(wakeResult);
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
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
  it.effect.each([true, false])(
    "carries a rejected wake rate limit into the continuation failure (event=%s)",
    (standaloneEvent) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          const resetsAt = 1790298600;

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-limit-1"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* Queue.take(harness.terminalReceipts);

          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          if (standaloneEvent) {
            yield* harness.offerAndWait(
              claudeSdkFrame({
                type: "rate_limit_event",
                rate_limit_info: {
                  status: "rejected",
                  rateLimitType: "five_hour",
                  resetsAt,
                  overageStatus: "rejected",
                },
                uuid: "00000000-0000-4000-8000-000000000630",
                session_id: WAKE_NATIVE_SESSION,
              }),
            );
          }
          assert.lengthOf(harness.continuationRequests, 0);
          yield* harness.offerAndWait(
            makeAssistantErrorFrame({
              uuid: "00000000-0000-4000-8000-000000000631",
              error: "rate_limit",
              apiErrorParams: {
                rate_limit_info: {
                  status: "rejected",
                  rateLimitType: "five_hour",
                  // A conflicting embedded time must not replace the event for this window.
                  resetsAt: standaloneEvent ? resetsAt + 3_600 : resetsAt,
                },
              },
            }),
          );
          assert.lengthOf(harness.continuationRequests, 1);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000632",
              result: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
              isError: true,
              apiErrorStatus: 429,
              terminalReason: "api_error",
              origin: { kind: "task-notification" },
            }),
          );
          assert.lengthOf(harness.continuationRequests, 1);

          // An empty session-task lifecycle result arriving before T3 opens the
          // wake run must not replace the root's terminal usage-limit result.
          yield* harness.offerAndWait(wakeTurnInit);
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000633",
              result: "",
              numTurns: 0,
              origin: { kind: "task-notification" },
              terminalReason: null,
            }),
          );

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-limit-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal?.status, "failed");
          if (terminal === undefined || terminal.status !== "failed") return;
          assert.equal(terminal.failure.class, "usage_limit");
          assert.equal(terminal.failure.resetAt, "2026-09-25T01:10:00.000Z");
          if (standaloneEvent) {
            const pause = yield* Queue.take(harness.systemNoticeReceipts);
            assert.equal(pause.turnItem.type, "system_notice");
            if (pause.turnItem.type !== "system_notice") return;
            assert.include(pause.turnItem.message, "This turn is paused until the 5-hour limit");
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
  it.effect(
    "dates a buffered wake gateway limit from its arrival, not the continuation replay",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-wake-gateway-1"),
              text: "Run the build in the background.",
              attachments: [],
            }),
          );
          yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
          yield* Queue.offer(harness.sdkMessages, turnOneResult);
          yield* Queue.take(harness.terminalReceipts);

          yield* Queue.offer(harness.sdkMessages, wakeNotification);
          yield* harness.offerAndWait(
            makeAssistantErrorFrame({
              uuid: "00000000-0000-4000-8000-000000000634",
              error: "server_error",
            }),
          );
          assert.lengthOf(harness.continuationRequests, 1);
          const arrivedAt = yield* DateTime.now;
          yield* harness.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000635",
              result:
                'API Error: 503 [cpa/claude-opus-5-5] [429]: {"type":"error","error":{"type":"rate_limit_error","message":"All credentials are cooling down"}} (reset after 2h54m21s)',
              isError: true,
              apiErrorStatus: 503,
              terminalReason: "api_error",
              origin: { kind: "task-notification" },
            }),
          );

          yield* TestClock.adjust("1 hour");
          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-claude-wake-gateway-2"),
              text: "Background task completed.",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, "failed");
          if (terminal.status !== "failed") return;
          assert.equal(terminal.failure.class, "usage_limit");
          assert.equal(
            terminal.failure.resetAt,
            DateTime.formatIso(
              DateTime.makeUnsafe(
                DateTime.toEpochMillis(arrivedAt) + (2 * 3_600 + 54 * 60 + 21) * 1_000,
              ),
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
  it.effect("leaves buffered wake messages for the continuation queued behind a user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* harness.awaitContinuation(1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4b"),
            text: "How is the build going?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );

        yield* harness.until(() => harness.offeredMessages.length === 2);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000105",
            result: "The build passed; nothing else pending.",
          }),
        );
        yield* harness.awaitTerminal(2);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(3);
        assert.equal(harness.terminalEvents()[2]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 2);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type !== "provider_thread.updated" &&
              JSON.stringify(event).includes(WAKE_TASK_ID),
          ),
        );
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
  it.effect("settles a continuation whose wake turn a user turn absorbed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-absorbed-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* harness.awaitTerminal(1);
        yield* harness.offerAndWait(wakeTurnInit);
        yield* harness.offerAndWait(wakeAssistant);
        yield* harness.awaitContinuation(1);

        // Claude folds this prompt into the wake turn it already opened, so one result ends both.
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-absorbed-2"),
            text: "Any update on the pull request?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* harness.until(() => harness.offeredMessages.length === 2);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000140",
            result: "Checks passed and the pull request is up to date.",
          }),
        );
        yield* harness.awaitTerminal(2);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-absorbed-3"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* harness.awaitTerminal(3);
        assert.equal(harness.terminalEvents()[2]?.status, "completed");
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "message.updated" && event.message.text === WAKE_ASSISTANT_TEXT,
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
