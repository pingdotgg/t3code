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
  options,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeAssistantErrorFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  lastProviderTurn,
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
  it.effect("an interrupted turn after a rollback stops resuming at the rolled-back head", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
      });
      const now = yield* DateTime.now;
      const pinnedHead = "00000000-0000-4000-8000-000000025510";
      const pinnedThread = {
        ...harness.providerThread,
        nativeConversationHeadRef: {
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeId: pinnedHead,
          strength: "weak" as const,
        },
      };
      const interruptedInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: pinnedThread,
        now,
        attemptId: RunAttemptId.make("attempt-claude-interrupt-after-rollback"),
        text: "The secret word is apricot-25510. Then run sleep 60.",
        attachments: [],
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: true,
      });
      yield* harness.runtime.startTurn(interruptedInput);
      assert.equal(harness.getOpenedOptions()?.resumeSessionAt, pinnedHead);
      yield* harness.offerAndWait(
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000025511",
          text: "Noted apricot-25510. Running sleep.",
        }),
      );
      yield* harness.runtime.interruptTurn({
        providerThread: pinnedThread,
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${interruptedInput.attemptId}`,
        }),
      });
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
      const afterInterrupt = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      )?.providerThread;
      assert.isDefined(afterInterrupt);
      assert.isNull(afterInterrupt.nativeConversationHeadRef);

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: afterInterrupt,
          now,
          attemptId: RunAttemptId.make("attempt-claude-after-interrupt"),
          text: "What is the secret word?",
          attachments: [],
          providerTurnOrdinal: 3,
          nativeThreadHasTurns: true,
        }),
      );
      assert.equal(harness.processQueues.length, 2);
      assert.isUndefined(harness.getOpenedOptions()?.resumeSessionAt);
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
  );
  it.effect("an interrupted turn with no assistant output keeps the rolled-back head", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
      });
      const now = yield* DateTime.now;
      const pinnedHead = "00000000-0000-4000-8000-000000025510";
      const pinnedThread = {
        ...harness.providerThread,
        nativeConversationHeadRef: {
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeId: pinnedHead,
          strength: "weak" as const,
        },
      };
      const interruptedInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread: pinnedThread,
        now,
        attemptId: RunAttemptId.make("attempt-claude-silent-interrupt-after-rollback"),
        text: "The secret word is apricot-25510. Then run sleep 60.",
        attachments: [],
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: true,
      });
      yield* harness.runtime.startTurn(interruptedInput);
      assert.equal(harness.getOpenedOptions()?.resumeSessionAt, pinnedHead);
      yield* harness.runtime.interruptTurn({
        providerThread: pinnedThread,
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${interruptedInput.attemptId}`,
        }),
      });
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
      const afterInterrupt = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      )?.providerThread;
      assert.isDefined(afterInterrupt);
      assert.equal(afterInterrupt.nativeConversationHeadRef?.nativeId, pinnedHead);

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: afterInterrupt,
          now,
          attemptId: RunAttemptId.make("attempt-claude-after-silent-interrupt"),
          text: "What is the secret word?",
          attachments: [],
          providerTurnOrdinal: 3,
          nativeThreadHasTurns: true,
        }),
      );
      assert.equal(harness.processQueues.length, 2);
      assert.equal(harness.getOpenedOptions()?.resumeSessionAt, pinnedHead);
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
  );
  it.effect("never records a subagent uuid for a turn with no main-thread assistant message", () =>
    Effect.gen(function* () {
      const forkCalls: Array<ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput> = [];
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
        forkSession: (input) =>
          Effect.sync(() => {
            forkCalls.push(input);
            return { sessionId: "forked-after-compact-rollback" };
          }),
      });
      const now = yield* DateTime.now;
      const subagentUuid = "00000000-0000-4000-8000-000000000644";
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-cursor-subagent-only"),
          text: "Background task completed.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: subagentUuid,
          error: undefined,
          parentToolUseId: "toolu_subagent",
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000645", result: "Done." }),
      ]);
      yield* Queue.take(harness.terminalReceipts);

      const providerTurn = lastProviderTurn(harness.events);
      assert.notEqual(providerTurn.nativeTurnRef?.nativeId, subagentUuid);
      const rollbackTo = (
        providerThreadTurns: ReadonlyArray<typeof providerTurn>,
        text = "Background task completed.",
        targetTurn = providerTurn,
      ) =>
        harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-claude-cursor-subagent-only"),
            appRunOrdinal: 1,
            providerTurn: targetTurn,
            message: { role: "user", text, attachments: [] },
          },
          providerThreadTurns,
        });

      const latest = yield* rollbackTo([providerTurn]);
      assert.isNull(latest.providerThread.nativeConversationHeadRef);
      const error = yield* rollbackTo([
        providerTurn,
        {
          ...providerTurn,
          id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
          ordinal: 2,
        },
      ]).pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapter.ProviderAdapterRollbackThreadError);
      assert.include(String(error.cause), "no SDK assistant message cursor");
      const earlierCursor = "00000000-0000-4000-8000-000000000648";
      const turnsAcrossSilent = [
        {
          ...providerTurn,
          id: ProviderTurnId.make("provider-turn-claude-cursor-earlier"),
          ordinal: providerTurn.ordinal - 1,
          nativeTurnRef: {
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeId: earlierCursor,
            strength: "weak",
          },
        },
        providerTurn,
        {
          ...providerTurn,
          id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
          ordinal: providerTurn.ordinal + 1,
        },
      ] satisfies ReadonlyArray<typeof providerTurn>;
      const semanticError = yield* rollbackTo(turnsAcrossSilent).pipe(Effect.flip);
      assert.instanceOf(semanticError, ProviderAdapter.ProviderAdapterRollbackThreadError);
      const pastSilentTurn = yield* rollbackTo(turnsAcrossSilent, "/compact");
      assert.equal(
        pastSilentTurn.providerThread.nativeConversationHeadRef?.nativeId,
        earlierCursor,
      );
      // Forks omit rolled-back turns, which Claude's transcript still holds past the pinned head.
      yield* harness.runtime.forkThread({
        sourceProviderThread: pastSilentTurn.providerThread,
        sourceProviderTurns: turnsAcrossSilent.slice(0, 2),
        providerTurnId: providerTurn.id,
        targetThreadId: ThreadId.make("thread-claude-fork-after-compact-rollback"),
      });
      assert.equal(forkCalls[0]?.options.upToMessageId, earlierCursor);
      const interruptedBeforeCompact = yield* rollbackTo(
        [
          {
            ...providerTurn,
            id: ProviderTurnId.make("provider-turn-claude-cursor-earlier"),
            ordinal: 1,
            nativeTurnRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: earlierCursor,
              strength: "weak",
            },
          },
          {
            ...providerTurn,
            id: ProviderTurnId.make("provider-turn-claude-interrupted-before-compact"),
            ordinal: 2,
            status: "interrupted",
          },
          { ...providerTurn, ordinal: 3 },
          {
            ...providerTurn,
            id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
            ordinal: 4,
          },
        ],
        "/compact",
        { ...providerTurn, ordinal: 3 },
      ).pipe(Effect.flip);
      assert.instanceOf(
        interruptedBeforeCompact,
        ProviderAdapter.ProviderAdapterRollbackThreadError,
      );

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: latest.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-cursor-subagent-only-next"),
          text: "Continue.",
          attachments: [],
          providerTurnOrdinal: 2,
        }),
      );
      const reopenedQueue = harness.processQueues[1];
      assert.isDefined(reopenedQueue);
      if (reopenedQueue === undefined) return;
      yield* Queue.offerAll(reopenedQueue, [
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000000646",
          text: "Continuing.",
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000647", result: "Done." }),
      ]);
      const next = yield* Queue.take(harness.terminalReceipts);
      assert.equal(next.status, "completed");
      assert.isUndefined(harness.getOpenedOptions()?.resumeSessionAt);
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
  );
  it.effect.each([
    {
      name: "fails a /compact the usage limit stopped",
      limited: true,
      compaction: "failed",
      compact: true,
      status: "failed",
    },
    {
      name: "completes an unlimited failed /compact",
      limited: false,
      compaction: "failed",
      compact: true,
      status: "completed",
    },
    {
      name: "completes a successful limited /compact",
      limited: true,
      compaction: "success",
      compact: true,
      status: "completed",
    },
    {
      name: "completes a failed automatic compaction",
      limited: true,
      compaction: "failed",
      compact: false,
      status: "completed",
    },
  ] as const)("$name", ({ name, limited, compaction, compact, status }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      const resetsAt = 1791991200;
      const compactError =
        "Error during compaction: You've hit your session limit · resets 5:20pm (Europe/Berlin).";
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`attempt-claude-compaction-${name}`),
          text: compact ? "/compact" : "Continue.",
          attachments: [],
        }),
      );
      // Failed /compact reports success without a terminal reason; status frames carry outcomes, including automatic compaction.
      const result = makeResultFrame({
        uuid: "00000000-0000-4000-8000-000000000613",
        result: compact ? "" : "Done.",
        numTurns: compact ? 0 : 1,
        terminalReason: null,
      });
      yield* Queue.offerAll(harness.sdkMessages, [
        ...(limited
          ? [
              claudeSdkFrame({
                type: "rate_limit_event",
                rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt },
                uuid: "00000000-0000-4000-8000-000000000611",
                session_id: WAKE_NATIVE_SESSION,
              }),
            ]
          : []),
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-4000-8000-000000000610",
          session_id: WAKE_NATIVE_SESSION,
        }),
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: null,
          compact_result: compaction,
          ...(compaction === "failed"
            ? { compact_error: limited ? compactError : "Not enough messages to compact." }
            : {}),
          uuid: "00000000-0000-4000-8000-000000000612",
          session_id: WAKE_NATIVE_SESSION,
        }),
        claudeSdkFrame({
          type: "system",
          subtype: "informational",
          content: "Compaction finished; turn continues.",
          level: "warning",
          uuid: "00000000-0000-4000-8000-000000000614",
          session_id: WAKE_NATIVE_SESSION,
        }),
      ]);
      yield* Queue.take(harness.systemNoticeReceipts);
      const updates = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "compaction"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(updates, 2);
      const [running, settled] = updates;
      assert.equal(running?.status, "running");
      assert.equal(settled?.status, compaction === "success" ? "completed" : "failed");
      assert.equal(
        settled?.type === "compaction" ? settled.summary : undefined,
        compaction === "failed"
          ? limited
            ? compactError
            : "Not enough messages to compact."
          : undefined,
      );
      assert.equal(settled?.id, running?.id);
      assert.equal(settled?.ordinal, running?.ordinal);
      assert.deepEqual(settled?.startedAt, running?.startedAt);
      assert.isNotNull(settled?.completedAt);
      assert.isEmpty(harness.terminalEvents());

      yield* Queue.offerAll(
        harness.sdkMessages,
        compact
          ? [
              // Claude Code echoes the command's stdout as a synthetic assistant message.
              claudeSdkFrame({
                ...makeAssistantTextFrame({
                  uuid: "00000000-0000-4000-8000-000000000615",
                  text: "Compacted.",
                }),
                local_command_source: "<local-command-stdout>Compacted.</local-command-stdout>",
              }),
              claudeSdkFrame({ ...result, local_command: "compact" }),
            ]
          : [result],
      );
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.deepEqual(
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        ),
        updates,
      );
      assert.equal(terminal.status, status);
      assert.equal(
        harness.events.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        ),
        !compact,
      );
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, "usage_limit");
      assert.equal(terminal.failure.message, compactError);
      assert.equal(
        terminal.failure.resetAt,
        DateTime.formatIso(DateTime.makeUnsafe(resetsAt * 1000)),
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
  );
  it.effect("keeps an unreported /compact failure's reason on the compaction, not as a reply", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-compaction-unreported"),
          text: "/compact",
          attachments: [],
        }),
      );
      // Claude can refuse a /compact without a compact_result: the only reason is the result text.
      yield* Queue.offerAll(harness.sdkMessages, [
        claudeSdkFrame({
          type: "system",
          subtype: "status",
          status: "compacting",
          uuid: "00000000-0000-4000-8000-000000000620",
          session_id: WAKE_NATIVE_SESSION,
        }),
        claudeSdkFrame({
          ...makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000622",
            text: "Not enough messages to compact.",
          }),
          local_command_source:
            "<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
        }),
        claudeSdkFrame({
          ...makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000621",
            result: "Not enough messages to compact.",
            numTurns: 0,
            terminalReason: null,
          }),
          local_command: "compact",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      const settled = harness.events
        .flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        )
        .at(-1);
      assert.equal(settled?.status, "failed");
      assert.equal(settled?.summary, "Not enough messages to compact.");
      assert.isFalse(
        harness.events.some(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
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
  );
  it.effect.each([
    { name: "parent limit", parentErrors: ["rate_limit"], expectedLimit: true },
    {
      name: "parent limit then nested response",
      parentErrors: ["rate_limit", "nested-ok"],
      expectedLimit: true,
    },
    { name: "nested limit", parentErrors: ["nested-limit"], expectedLimit: false },
    {
      name: "parent limit then parent response",
      parentErrors: ["rate_limit", "ok"],
      expectedLimit: false,
    },
  ])("classifies retried terminal API failures after $name", ({ parentErrors, expectedLimit }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`attempt-claude-retry-${parentErrors.join("-")}`),
          text: "Continue.",
          attachments: [],
        }),
      );
      for (const [index, evidence] of parentErrors.entries()) {
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantErrorFrame({
            uuid: `00000000-0000-4000-8000-00000000062${index}`,
            error: evidence.includes("limit") ? "rate_limit" : undefined,
            parentToolUseId: evidence.startsWith("nested") ? "nested-tool" : null,
            ...(evidence.includes("limit")
              ? {
                  apiErrorParams: {
                    rate_limit_info: {
                      status: "rejected",
                      rateLimitType: "five_hour",
                      resetsAt: 1790298600,
                    },
                  },
                }
              : {}),
          }),
        );
      }
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000629",
          result: "API Error",
          isError: true,
          terminalReason: "api_error",
        }),
      );

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, expectedLimit ? "usage_limit" : "provider_error");
      assert.equal(
        terminal.failure.resetAt,
        expectedLimit ? "2026-09-25T01:10:00.000Z" : undefined,
      );
      assert.equal(
        terminal.failure.message,
        expectedLimit
          ? "Claude usage limit reached. Send the message again once the limit resets."
          : "Claude gave up after repeated API errors.",
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
  );
});
