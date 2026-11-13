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

describe("ClaudeAdapterV2 attachments", () => {
  it.effect.each([
    ...[
      "retained-images",
      "retained-text",
      "same-message-images",
      "retained-documents",
      "later-images",
      "partial-images",
      "cancelled-send",
      "cancelled-steer",
    ].map((budget) => ({
      name: budget,
      prompt: "Read this PDF.",
      expectedText: "Read this PDF.",
      command: undefined,
      ultrathink: false,
      resumed: false,
      budget,
    })),
    {
      name: "ordinary text",
      prompt: "What’s in this image?",
      expectedText: "Ultrathink:\nWhat’s in this image?",
      command: undefined,
      ultrathink: true,
      resumed: false,
      budget: "none",
    },
    {
      name: "mid-sentence skill",
      prompt: "please $implement fixes\n\nThen report the result",
      expectedText: "Ultrathink:\nplease /implement fixes\n\nThen report the result",
      command: "/implement fixes\n\nThen report the result",
      ultrathink: true,
      resumed: false,
      budget: "none",
    },
    {
      name: "prompt-leading skill",
      prompt: "$implement fixes",
      expectedText: "/implement fixes",
      command: undefined,
      ultrathink: false,
      resumed: false,
      budget: "none",
    },
    {
      name: "resumed history without persisted counters",
      prompt: "Inspect this file",
      expectedText: "Ultrathink:\nInspect this file",
      command: undefined,
      ultrathink: true,
      resumed: true,
      budget: "none",
    },
  ])(
    "preserves $name with native PDFs, images, and paths on sends and steering",
    ({ prompt, expectedText, command, ultrathink, resumed, budget }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const path = yield* Path.Path;
          const claudeHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-skills-home-",
          });
          yield* fileSystem.makeDirectory(path.join(claudeHome, "skills", "implement"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(claudeHome, "skills", "implement", "SKILL.md"),
            "---\ndescription: Implement the requested change\n---\nImplement it.\n",
          );
          const modelSelection = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            options: ultrathink ? CLAUDE_TEST_MODEL_SELECTION.options : [],
          };
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-attachments-",
          });
          const offeredMessages: Array<SDKUserMessage> = [];
          let failOpen = false;
          let failOffer = false;
          let cancelAfterQueue = false;
          const queued = yield* Deferred.make<void>();
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: claudeHome },
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            random: yield* SecureRandom.SecureRandom,
            idAllocator,
            queryRunner: {
              allocateSessionId: Effect.succeed("native-thread-claude-attachments"),
              open: () =>
                Effect.gen(function* () {
                  if (failOpen) {
                    failOpen = false;
                    return yield* new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                      method: "open",
                      cause: "rejected open",
                    });
                  }
                  const messages = yield* Queue.unbounded<SDKMessage>();
                  return {
                    messages: Stream.fromQueue(messages),
                    offer: (message, onQueued) =>
                      Effect.suspend(() => {
                        if (failOffer) {
                          failOffer = false;
                          return Effect.fail(
                            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                              method: "offer",
                              cause: "rejected offer",
                            }),
                          );
                        }
                        return Effect.sync(() => {
                          offeredMessages.push(message);
                          onQueued?.();
                        }).pipe(
                          Effect.andThen(() =>
                            cancelAfterQueue
                              ? Deferred.succeed(queued, undefined).pipe(
                                  Effect.andThen(Effect.never),
                                )
                              : Effect.void,
                          ),
                        );
                      }),
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    setPermissionMode: () => Effect.void,
                    backgroundTasks: () => Effect.succeed(false),
                    stopTask: () => Effect.void,
                    interrupt: Effect.void,
                    close: Queue.shutdown(messages),
                  };
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-attachments");
          const providerSessionId = ProviderSessionId.make("provider-session-claude-attachments");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const attachment = ChatImageAttachment.make({
            type: "image",
            id: ChatAttachmentId.make(
              "thread-claude-attachments-12345678-1234-1234-1234-123456789abc",
            ),
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 4,
          });
          const document = ChatFileAttachment.make({
            type: "file",
            id: ChatAttachmentId.make(
              "thread-claude-attachments-abcdefab-1234-1234-1234-123456789abc",
            ),
            name: "requirements.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4,
          });
          yield* fileSystem.writeFile(
            path.join(attachmentsDir, attachmentRelativePath(attachment)!),
            Uint8Array.from([1, 2, 3, 4]),
          );
          const pdfBytes = Buffer.from(
            "%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R >> endobj\n%%EOF",
          );
          yield* fileSystem.writeFile(
            path.join(attachmentsDir, attachmentRelativePath(document)!),
            pdfBytes,
          );
          const attemptId = RunAttemptId.make("attempt-claude-attachments");
          const now = yield* DateTime.now;

          const turnInput = {
            ...makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId,
              modelSelection,
              text: prompt,
              attachments: resumed ? [attachment] : [attachment, document],
            }),
            nativeThreadHasTurns: resumed,
          };
          if (budget === "cancelled-send" || budget === "cancelled-steer") {
            const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
            const pages = Buffer.from(
              `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 60 >> endobj\n${Array.from({ length: 60 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n`,
            );
            yield* fileSystem.writeFile(
              documentPath,
              Buffer.concat([
                pages,
                Buffer.alloc(19 * 1024 * 1024 - pages.length - 5, 32),
                Buffer.from("%%EOF"),
              ]),
            );
            const message = { ...turnInput.message, attachments: [document] };
            if (budget === "cancelled-steer") {
              yield* runtime.startTurn({ ...turnInput, message: { ...message, attachments: [] } });
            }
            const deliver =
              budget === "cancelled-send"
                ? runtime.startTurn({ ...turnInput, message })
                : runtime.steerTurn({
                    threadId,
                    runId: turnInput.runId,
                    providerThread,
                    providerTurnId: idAllocator.derive.providerTurn({
                      driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                      nativeTurnId: `turn:${attemptId}`,
                    }),
                    message,
                  });
            cancelAfterQueue = true;
            const delivering = yield* deliver.pipe(Effect.forkChild);
            yield* Deferred.await(queued);
            yield* Fiber.interrupt(delivering);
            const delivered = offeredMessages.at(-1)!.message.content;
            assert.include(JSON.stringify(delivered), '"type":"document"');
            cancelAfterQueue = false;
            if (budget === "cancelled-send") {
              yield* runtime.interruptTurn({
                providerThread,
                providerTurnId: idAllocator.derive.providerTurn({
                  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                  nativeTurnId: `turn:${attemptId}`,
                }),
              });
            }
            yield* deliver;
            const retried = offeredMessages.at(-1)!.message.content;
            assert.notInclude(JSON.stringify(retried), '"type":"document"');
            assert.include(JSON.stringify(retried), documentPath);
            assert.isBelow(Buffer.byteLength(JSON.stringify(offeredMessages)), 32_000_000);
            return;
          }
          if (budget !== "none") {
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeTurnId: `turn:${attemptId}`,
            });
            const imagePath = path.join(attachmentsDir, attachmentRelativePath(attachment)!);
            // The on-disk length deliberately disagrees with sizeBytes.
            yield* fileSystem.writeFile(imagePath, Buffer.alloc(4 * 1024 * 1024));
            if (["later-images", "partial-images"].includes(budget)) {
              const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
              yield* fileSystem.writeFile(
                documentPath,
                Buffer.concat([
                  pdfBytes.subarray(0, -5),
                  Buffer.alloc(
                    (budget === "later-images" ? 19 : 16) * 1024 * 1024 - pdfBytes.length,
                    32,
                  ),
                  Buffer.from("%%EOF"),
                ]),
              );
              yield* runtime.startTurn({
                ...turnInput,
                message: { ...turnInput.message, attachments: [document] },
              });
              assert.include(
                JSON.stringify(offeredMessages[0]!.message.content),
                '"type":"document"',
              );
              const message = { ...turnInput.message, attachments: [attachment, attachment] };
              yield* runtime.interruptTurn({ providerThread, providerTurnId });
              const laterAttemptId = RunAttemptId.make("attempt-claude-attachments-later");
              yield* runtime.startTurn({
                ...turnInput,
                attemptId: laterAttemptId,
                providerTurnOrdinal: 2,
                nativeThreadHasTurns: true,
                message,
              });
              const sent = offeredMessages.at(-1)!.message.content;
              assert.isArray(sent);
              assert.lengthOf(
                typeof sent === "string" ? [] : sent.filter((block) => block.type === "image"),
                budget === "partial-images" ? 1 : 0,
              );
              assert.include(JSON.stringify(sent), imagePath);
              yield* runtime.steerTurn({
                threadId,
                runId: RunId.make("run-claude-attachments"),
                providerThread,
                providerTurnId: idAllocator.derive.providerTurn({
                  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                  nativeTurnId: `turn:${laterAttemptId}`,
                }),
                message,
              });
              const steered = offeredMessages.at(-1)!.message.content;
              assert.isArray(steered);
              assert.lengthOf(
                typeof steered === "string"
                  ? []
                  : steered.filter((block) => block.type === "image"),
                0,
              );
              assert.include(JSON.stringify(steered), imagePath);
              assert.isBelow(
                Buffer.byteLength(
                  JSON.stringify(offeredMessages.map((message) => message.message)),
                ),
                32_000_000,
              );
              return;
            }
            if (budget === "retained-documents") {
              yield* fileSystem.writeFile(
                path.join(attachmentsDir, attachmentRelativePath(document)!),
                Buffer.concat([
                  pdfBytes.subarray(0, pdfBytes.length - 5),
                  Buffer.alloc(10 * 1024 * 1024, 32),
                  Buffer.from("%%EOF"),
                ]),
              );
            }
            yield* runtime.startTurn({
              ...turnInput,
              message: {
                ...turnInput.message,
                text: budget === "retained-text" ? "x".repeat(10 * 1024 * 1024) : prompt,
                attachments:
                  budget === "retained-text"
                    ? []
                    : budget === "retained-documents"
                      ? [document]
                      : [attachment, attachment],
              },
            });
            const largePdf = Buffer.concat([
              pdfBytes.subarray(0, pdfBytes.length - 5),
              Buffer.alloc(
                (budget === "retained-documents" ? 20 : 19) * 1024 * 1024 - pdfBytes.length,
                32,
              ),
              Buffer.from("%%EOF"),
            ]);
            const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
            yield* fileSystem.writeFile(documentPath, largePdf);
            yield* runtime.steerTurn({
              threadId,
              runId: RunId.make("run-claude-attachments"),
              providerThread,
              providerTurnId,
              message: {
                ...turnInput.message,
                attachments:
                  budget === "same-message-images"
                    ? [document, attachment, attachment]
                    : [document],
              },
            });
            const sent = offeredMessages.at(-1)!.message.content;
            assert.isArray(sent);
            assert.lengthOf(
              typeof sent === "string" ? [] : sent.filter((block) => block.type === "document"),
              0,
              budget,
            );
            assert.include(JSON.stringify(sent), documentPath);
            return;
          }
          if (!resumed) {
            const undelivered = Buffer.from(
              `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count 60 >> endobj\n${Array.from({ length: 60 }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n%%EOF`,
            );
            yield* fileSystem.writeFile(
              path.join(attachmentsDir, attachmentRelativePath(document)!),
              undelivered,
            );
            failOpen = true;
            assert.isTrue(Exit.isFailure(yield* runtime.startTurn(turnInput).pipe(Effect.exit)));
            assert.lengthOf(offeredMessages, 0);
            yield* fileSystem.writeFile(
              path.join(attachmentsDir, attachmentRelativePath(document)!),
              pdfBytes,
            );
          }
          yield* runtime.startTurn(turnInput);

          const expectedImageBlock = {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AQIDBA==",
            },
          } as const;
          const expectedDocumentBlock = {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: Buffer.from(pdfBytes).toString("base64"),
            },
          } as const;
          const expectedAttachmentPath = path.join(
            attachmentsDir,
            attachmentRelativePath(attachment)!,
          );
          const expectedDocumentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
          const attachmentNotes = `\n\n[Attached image "diagram.png" is saved at: ${expectedAttachmentPath}]${resumed ? "" : `\n\n[Attached file "requirements.pdf" is saved at: ${expectedDocumentPath}]`}`;
          const requestBlock = { type: "text" as const, text: expectedText + attachmentNotes };
          const expectedContent = command
            ? [
                requestBlock,
                expectedImageBlock,
                ...(!resumed ? [expectedDocumentBlock] : []),
                { type: "text" as const, text: command + attachmentNotes },
              ]
            : [expectedImageBlock, ...(!resumed ? [expectedDocumentBlock] : []), requestBlock];
          assert.deepEqual(offeredMessages[0]?.message.content, expectedContent);

          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });
          yield* runtime.steerTurn({
            threadId,
            runId: RunId.make("run-claude-attachments"),
            providerThread,
            providerTurnId,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-claude-attachments-steer"),
              text: prompt,
              attachments: resumed ? [attachment] : [attachment, document],
            },
          });

          assert.equal(offeredMessages[1]?.priority, "now");
          assert.deepEqual(offeredMessages[1]?.message.content, expectedContent);
          const documentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
          for (const scenario of [
            "pages",
            "bytes",
            "invalid",
            "invalid-page-tree",
            "object-stream",
            "encrypted",
            "cyclic-tree",
            "unterminated-string",
            "missing-eof",
            "escaped-name",
            "incremental",
            "compressed-bomb",
            "indirect-count",
            "indirect-type",
            "indirect-kids",
            "indirect-101-pages",
            "aggregate-pages",
            "retained-pages",
            "delivery-failure",
            "pasted-text",
            "text-only",
          ]) {
            let attachments: ReadonlyArray<ChatAttachment> = [document];
            if (
              ["pages", "aggregate-pages", "retained-pages", "delivery-failure"].includes(scenario)
            ) {
              const pages = scenario === "pages" ? 101 : scenario === "delivery-failure" ? 30 : 60;
              const large = Buffer.from(
                `%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Count ${pages} >> endobj\n${Array.from({ length: pages }, (_, i) => `${i + 3} 0 obj << /Type /Page /Parent 2 0 R >> endobj`).join("\n")}\n%%EOF`,
              );
              yield* fileSystem.writeFile(documentPath, large);
              if (scenario === "aggregate-pages") {
                const second = {
                  ...document,
                  id: ChatAttachmentId.make("second-pdf"),
                  name: "second.pdf",
                };
                yield* fileSystem.copyFile(
                  documentPath,
                  path.join(attachmentsDir, attachmentRelativePath(second)!),
                );
                attachments = [document, second];
              }
            } else if (scenario.startsWith("indirect-")) {
              const raw =
                scenario === "indirect-count" || scenario === "indirect-101-pages"
                  ? `%PDF-1.7\n1 0 obj ${scenario === "indirect-count" ? 1 : 101} endobj\n2 0 obj << /Type /Catalog /Pages 3 0 R >> endobj\n3 0 obj << /Type /Pages /Count 1 0 R /Kids [${Array.from({ length: scenario === "indirect-count" ? 1 : 101 }, (_, i) => `${i + 4} 0 R`).join(" ")}] >> endobj\n4 0 obj << /Type /Page /Parent 3 0 R >> endobj\n${scenario === "indirect-count" ? "" : Array.from({ length: 100 }, (_, i) => `${i + 5} 0 obj << /Type 105 0 R /Parent 3 0 R >> endobj`).join("\n")}\n105 0 obj /Page endobj\n%%EOF`
                  : scenario === "indirect-type"
                    ? pdfBytes
                        .toString()
                        .replace(
                          "%%EOF",
                          "4 0 obj << /Type 5 0 R >> endobj\n5 0 obj /Annot endobj\n%%EOF",
                        )
                    : pdfBytes
                        .toString()
                        .replace("/Kids [3 0 R]", "/Kids 4 0 R")
                        .replace("%%EOF", "4 0 obj [3 0 R] endobj\n%%EOF");
              yield* fileSystem.writeFileString(documentPath, raw);
            } else if (scenario === "bytes") {
              yield* fileSystem.truncate(documentPath, 20 * 1024 * 1024 + 1);
            } else if (scenario === "invalid") {
              yield* fileSystem.writeFileString(documentPath, "This is not a PDF");
            } else if (scenario === "invalid-page-tree") {
              const malformedBytes = Buffer.from(
                "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 42 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF",
              );
              yield* fileSystem.writeFile(documentPath, malformedBytes);
            } else if (
              ["object-stream", "encrypted", "cyclic-tree", "compressed-bomb"].includes(scenario)
            ) {
              const suffix =
                scenario === "encrypted"
                  ? "/Encrypt 9 0 R"
                  : scenario === "cyclic-tree"
                    ? "/Count 0 /Kids [2 0 R]"
                    : "/Type /ObjStm /Filter /FlateDecode /Length 1000000000";
              yield* fileSystem.writeFile(
                documentPath,
                Buffer.concat([
                  pdfBytes.subarray(0, pdfBytes.length - 5),
                  Buffer.from(`\n4 0 obj << ${suffix} >> stream\nx\nendstream endobj\n%%EOF`),
                ]),
              );
            } else if (
              ["unterminated-string", "missing-eof", "escaped-name", "incremental"].includes(
                scenario,
              )
            ) {
              const raw = pdfBytes.toString();
              yield* fileSystem.writeFileString(
                documentPath,
                scenario === "missing-eof"
                  ? raw.slice(0, -5)
                  : scenario === "escaped-name"
                    ? raw.replace("/Type /Page ", "/Type /Pa#67e ")
                    : raw.replace(
                        "%%EOF",
                        scenario === "incremental" ? "/Prev 42\n%%EOF" : "(unfinished\n%%EOF",
                      ),
              );
            } else if (scenario === "pasted-text") {
              yield* fileSystem.writeFile(documentPath, pdfBytes);
              attachments = [{ ...document, source: { _tag: "pasted-text" } }];
            } else {
              attachments = [];
              yield* fileSystem.remove(documentPath);
            }
            const steering = {
              threadId,
              runId: RunId.make("run-claude-attachments"),
              providerThread,
              providerTurnId,
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make(`message-${scenario}`),
                text: "Continue.",
                attachments,
              },
            } satisfies ProviderAdapter.ProviderAdapterV2SteerInput;
            if (scenario === "delivery-failure") {
              failOffer = true;
              assert.isTrue(Exit.isFailure(yield* runtime.steerTurn(steering).pipe(Effect.exit)));
            }
            yield* runtime.steerTurn(steering);

            const sent = offeredMessages.at(-1)!.message.content;
            const documents =
              typeof sent === "string" ? [] : sent.filter((block) => block.type === "document");
            assert.lengthOf(
              documents,
              ["aggregate-pages", "delivery-failure"].includes(scenario) ? 1 : 0,
              scenario,
            );
            if (scenario === "text-only")
              assert.equal(sent, ultrathink ? "Ultrathink:\nContinue." : "Continue.");
            else assert.include(JSON.stringify(sent), documentPath);
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
});
