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
  encodeJsonString,
  encodeProviderThreadJson,
  decodeProviderThreadJson,
  WAKE_NATIVE_SESSION,
  claudeSdkFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
  makeWakeHarness,
  attachmentBudgetOutcomes,
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
  it.effect.each(["release-after", "cancel-after", "release-before", "resume-pending"] as const)(
    "keeps attachment reservations across compaction: %s boundary",
    (outcome) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const backgrounding = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          backgroundTasks: () =>
            Deferred.succeed(backgrounding, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(true),
            ),
        });
        const document = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make("compacting-document"),
          name: "compacting.pdf",
          mimeType: "application/pdf",
          sizeBytes: 19 * 1024 * 1024,
        });
        const pages = Buffer.from(
          `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 60 >> endobj\n${Array.from({ length: 60 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n`,
        );
        yield* fileSystem.writeFile(
          path.join(harness.attachmentsDir, attachmentRelativePath(document)!),
          Buffer.concat([
            pages,
            Buffer.alloc(document.sizeBytes - pages.length - 5, 32),
            Buffer.from("%%EOF"),
          ]),
        );
        const input = makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("compacting-reservation"),
          text: "Audit with a subagent.",
          attachments: [],
        });
        yield* harness.runtime.startTurn(input);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "compacting-task",
            tool_use_id: "compacting-tool",
            description: "Audit",
            subagent_type: "general-purpose",
            is_backgrounded: false,
            task_type: "local_agent",
            prompt: "Audit.",
            uuid: "00000000-0000-4000-8000-000000000811",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const steer = harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: input.runId,
          providerThread: harness.providerThread,
          providerTurnId: idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${input.attemptId}`,
          }),
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("compacting-steer"),
            text: "Read this PDF.",
            attachments: [document],
          },
        });
        const pending = yield* Effect.forkScoped(steer);
        yield* Deferred.await(backgrounding);
        assert.lengthOf(harness.offeredMessages, 1);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "status",
            status: "compacting",
            uuid: "00000000-0000-4000-8000-000000000812",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        if (outcome === "release-before") {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
        }
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 1500, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000813",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        if (outcome === "cancel-after") {
          yield* Fiber.interrupt(pending);
          assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(pending)));
        } else if (outcome === "release-after") {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(pending);
        }
        // Flush the budget update through the event stream before trying again.
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000814", result: "Read." }),
        );
        yield* Queue.take(harness.terminalReceipts);
        const updates = harness.events.flatMap((event) =>
          event.type === "provider_thread.updated" ? [event.providerThread] : [],
        );
        for (const thread of updates) {
          yield* decodeProviderThreadJson(yield* encodeProviderThreadJson(thread));
        }
        const persisted = yield* decodeProviderThreadJson(
          yield* encodeProviderThreadJson(updates.at(-1)!),
        );
        const usage = persisted.nativeMetadata?.claudeAttachmentBudget;
        const undelivered = outcome === "cancel-after" || outcome === "resume-pending";
        assert.equal(usage?.pagesUsed, undelivered ? 0 : 60);
        if (undelivered) assert.equal(usage?.bytesUsed, 0);
        else assert.isAbove(usage?.bytesUsed ?? 0, 25 * 1024 * 1024);
        const next = outcome === "resume-pending" ? yield* makeWakeHarness : harness;
        const providerThread =
          outcome === "resume-pending"
            ? yield* next.runtime.resumeThread({ providerThread: persisted })
            : persisted;
        if (outcome === "resume-pending") {
          assert.lengthOf(harness.offeredMessages, 1);
          yield* fileSystem.copyFile(
            path.join(harness.attachmentsDir, attachmentRelativePath(document)!),
            path.join(next.attachmentsDir, attachmentRelativePath(document)!),
          );
        }
        yield* next.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: next.threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("after-compacting-reservation"),
            text: "Read this PDF again.",
            attachments: [document],
            providerTurnOrdinal: 2,
            nativeThreadHasTurns: true,
          }),
        );
        if (outcome === "resume-pending") {
          assert.equal(next.getOpenedOptions()?.resume, WAKE_NATIVE_SESSION);
        }
        const delivered = next.offeredMessages.slice(outcome === "resume-pending" ? 0 : 1);
        const documents = delivered.flatMap((message) =>
          Array.isArray(message.message.content)
            ? message.message.content.filter((block) => block.type === "document")
            : [],
        );
        assert.lengthOf(documents, 1);
        assert.isBelow(
          Buffer.byteLength(encodeJsonString(delivered.map((message) => message.message.content))),
          32_000_000,
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
  it.effect.each(attachmentBudgetOutcomes)(
    "restores retained attachment counters after %s",
    (outcome) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const document = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make("budget-document"),
          name: "budget.pdf",
          mimeType: "application/pdf",
          sizeBytes: 19 * 1024 * 1024,
        });
        const image = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make("budget-image"),
          name: "budget.png",
          mimeType: "image/png",
          sizeBytes: 4 * 1024 * 1024,
        });
        const pages = Buffer.from(
          `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 100 >> endobj\n${Array.from({ length: 100 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n`,
        );
        const persisted = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeWakeHarness;
            yield* fileSystem.writeFile(
              path.join(harness.attachmentsDir, attachmentRelativePath(document)!),
              Buffer.concat([
                pages,
                Buffer.alloc(document.sizeBytes - pages.length - 5, 32),
                Buffer.from("%%EOF"),
              ]),
            );
            yield* harness.runtime.startTurn(
              makeClaudeTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("spend-attachment-budget"),
                text: "Read this PDF.",
                attachments: [document],
              }),
            );
            const first = harness.offeredMessages[0]?.message.content;
            assert.isArray(first);
            if (Array.isArray(first)) assert.equal(first[0]?.type, "document");
            if (
              [
                "compacted",
                "preserved-segment",
                "preserved-messages",
                "failed",
                "stopped",
              ].includes(outcome)
            ) {
              yield* harness.offerAndWait(
                claudeSdkFrame({
                  type: "system",
                  subtype: "status",
                  status: "compacting",
                  uuid: "00000000-0000-4000-8000-000000000801",
                  session_id: WAKE_NATIVE_SESSION,
                }),
              );
              yield* harness.offerAndWait(
                claudeSdkFrame(
                  outcome === "compacted" ||
                    outcome === "preserved-segment" ||
                    outcome === "preserved-messages"
                    ? {
                        type: "system",
                        subtype: "compact_boundary",
                        compact_metadata: {
                          trigger: "auto",
                          pre_tokens: 1500,
                          post_tokens: 400,
                          ...(outcome === "preserved-segment"
                            ? {
                                preserved_segment: {
                                  head_uuid: harness.promptUuid(0),
                                  tail_uuid: harness.promptUuid(0),
                                  anchor_uuid: "00000000-0000-4000-8000-000000000802",
                                },
                              }
                            : outcome === "preserved-messages"
                              ? {
                                  preserved_messages: {
                                    anchor_uuid: "00000000-0000-4000-8000-000000000802",
                                    uuids: [harness.promptUuid(0)],
                                  },
                                }
                              : {}),
                        },
                        uuid: "00000000-0000-4000-8000-000000000802",
                        session_id: WAKE_NATIVE_SESSION,
                      }
                    : {
                        type: "system",
                        subtype: "status",
                        status: null,
                        ...(outcome === "failed"
                          ? { compact_result: "failed", compact_error: "Could not compact." }
                          : {}),
                        uuid: "00000000-0000-4000-8000-000000000802",
                        session_id: WAKE_NATIVE_SESSION,
                      },
                ),
              );
            }
            yield* harness.offerAndWait(
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000803",
                result: "Read.",
              }),
            );
            yield* Queue.take(harness.terminalReceipts);
            const event = harness.events.findLast(
              (entry) => entry.type === "provider_thread.updated",
            );
            assert.equal(event?.type, "provider_thread.updated");
            if (event?.type !== "provider_thread.updated")
              return yield* Effect.die("Missing persisted thread");
            const budget = event.providerThread.nativeMetadata?.claudeAttachmentBudget;
            assert.isDefined(budget);
            if (outcome === "compacted") assert.deepEqual(budget, { bytesUsed: 0, pagesUsed: 0 });
            else {
              assert.equal(budget?.pagesUsed, 100);
              assert.isAbove(budget?.bytesUsed ?? 0, 25 * 1024 * 1024);
            }
            // Exercise the same schema boundary as the persisted provider thread.
            return yield* decodeProviderThreadJson(
              yield* encodeProviderThreadJson({
                ...event.providerThread,
                ...(outcome === "legacy" ? { nativeMetadata: null } : {}),
              }),
            );
          }),
        );
        const fork = outcome === "fork-bytes" || outcome === "fork-pages";
        const inherited = fork
          ? yield* Effect.scoped(
              Effect.gen(function* () {
                const harness = yield* makeWakeHarnessWithOptions({
                  forkSession: () =>
                    Effect.succeed({
                      sessionId: "forked-native-session",
                      ...(outcome === "fork-bytes"
                        ? { headMessageId: "forked-assistant-head" }
                        : {}),
                    }),
                });
                const forked = yield* harness.runtime.forkThread({
                  sourceProviderThread: persisted,
                  targetThreadId: harness.threadId,
                });
                return yield* decodeProviderThreadJson(yield* encodeProviderThreadJson(forked));
              }),
            )
          : persisted;
        const resumed = yield* makeWakeHarness;
        const providerThread = yield* resumed.runtime.resumeThread({ providerThread: inherited });
        yield* fileSystem.writeFileString(
          path.join(resumed.attachmentsDir, attachmentRelativePath(document)!),
          "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF",
        );
        yield* fileSystem.writeFile(
          path.join(resumed.attachmentsDir, attachmentRelativePath(image)!),
          Buffer.alloc(image.sizeBytes, 1),
        );
        yield* resumed.runtime.startTurn({
          ...makeClaudeTestTurnInput({
            threadId: resumed.threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("resume-attachment-budget"),
            text: "Read the PDF and both images.",
            attachments:
              outcome === "fork-bytes"
                ? [image, image]
                : outcome === "fork-pages"
                  ? [document]
                  : [document, image, image],
          }),
          nativeThreadHasTurns: true,
        });
        assert.equal(
          resumed.getOpenedOptions()?.resume,
          fork ? "forked-native-session" : WAKE_NATIVE_SESSION,
        );
        const content = resumed.offeredMessages[0]?.message.content;
        assert.isArray(content);
        if (!Array.isArray(content)) return;
        const native = outcome === "legacy" || outcome === "compacted";
        assert.equal(content.filter((block) => block.type === "document").length, native ? 1 : 0);
        assert.equal(content.filter((block) => block.type === "image").length, native ? 2 : 0);
        assert.isBelow(Buffer.byteLength(encodeJsonString(content)), 32_000_000);
        if (fork) {
          assert.deepEqual(
            inherited.nativeMetadata?.claudeAttachmentBudget,
            persisted.nativeMetadata?.claudeAttachmentBudget,
          );
          assert.equal(
            inherited.nativeMetadata?.forkHeadMessageId,
            outcome === "fork-bytes" ? "forked-assistant-head" : undefined,
          );
          assert.isBelow(
            (persisted.nativeMetadata?.claudeAttachmentBudget?.bytesUsed ?? 0) +
              Buffer.byteLength(encodeJsonString(content)),
            32_000_000,
          );
          assert.include(encodeJsonString(content), "budget.");
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
  );
});
