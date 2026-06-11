import type { ChatAttachment, OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ExternalIntegrationRepository } from "../persistence/Services/ExternalIntegrations.ts";
import { ExternalChat } from "./ExternalChat.ts";
import { extractGitHubPullRequests } from "./github.ts";
import { postableReplyBody, postableUserInputRequest } from "./postableReply.ts";
import { derivePendingExternalUserInputs } from "./userInputSlack.ts";

type AssistantMessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
type ThreadSessionSetEvent = Extract<OrchestrationEvent, { type: "thread.session-set" }>;
type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;

interface AssistantTurnRelayState {
  readonly threadId: ThreadId;
  readonly turnId: string | null;
  firstRelayedText: string | null;
  finalRelayedText: string | null;
  lastMessageId: string | null;
  readonly messageTextById: Map<string, string>;
  readonly messageAttachmentsById: Map<string, ReadonlyArray<ChatAttachment>>;
}

function nowIso() {
  return DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe()));
}

function shouldRelayAssistantMessage(event: AssistantMessageEvent) {
  return event.payload.role === "assistant" && event.payload.text.trim().length > 0;
}

function normalizedAssistantText(text: string) {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function relayTurnKey(input: {
  readonly threadId: ThreadId | string;
  readonly turnId: string | null;
  readonly messageId: string;
}) {
  return `${String(input.threadId)}:${input.turnId ?? `message:${input.messageId}`}`;
}

export function assistantTextDeliveryKey(input: {
  readonly phase: "first" | "final";
  readonly threadId: ThreadId | string;
  readonly turnId: string | null;
  readonly messageId: string;
  readonly externalThreadId: string;
}) {
  return `assistant-message:${input.phase}:${relayTurnKey(input)}:${input.externalThreadId}`;
}

export function assistantAttachmentDeliveryKey(input: {
  readonly phase: "first" | "final";
  readonly threadId: ThreadId | string;
  readonly turnId: string | null;
  readonly messageId: string;
  readonly attachmentId: string;
  readonly externalThreadId: string;
}) {
  return `assistant-attachment:${input.phase}:${relayTurnKey(input)}:${input.attachmentId}:${input.externalThreadId}`;
}

export function shouldFinalizeAssistantRelayFromMessage(input: {
  readonly streaming: boolean;
  readonly turnId: string | null;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
}) {
  return (
    input.streaming === false &&
    (input.turnId === null || (input.attachments !== undefined && input.attachments.length > 0))
  );
}

export const makeExternalIntakeReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const repository = yield* ExternalIntegrationRepository;
  const externalChat = yield* ExternalChat;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverConfig = yield* ServerConfig;
  const assistantRelayStateByTurn = new Map<string, AssistantTurnRelayState>();

  const recordPullRequests = (input: { readonly threadId: ThreadId; readonly text: string }) =>
    Effect.gen(function* () {
      const now = nowIso();
      for (const pullRequest of extractGitHubPullRequests(input.text)) {
        yield* repository.upsertArtifactLink({
          kind: "github_pr",
          externalId: pullRequest.externalId,
          t3ThreadId: input.threadId,
          url: pullRequest.url,
          metadata: pullRequest,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

  const postAssistantRelayToSlack = (input: {
    readonly threadId: ThreadId;
    readonly turnId: string | null;
    readonly messageId: string;
    readonly text: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly phase: "first" | "final";
  }) =>
    Effect.gen(function* () {
      const links = yield* repository.listThreadLinksByThread(input.threadId);
      const now = nowIso();
      const attachmentFiles = yield* Effect.forEach(
        input.attachments ?? [],
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              yield* Effect.logWarning("external intake could not resolve attachment for Slack", {
                threadId: String(input.threadId),
                messageId: input.messageId,
                attachmentId: attachment.id,
              });
              return null;
            }
            const data = yield* fileSystem
              .readFile(attachmentPath)
              .pipe(Effect.orElseSucceed(() => null));
            if (data === null) {
              yield* Effect.logWarning("external intake could not read attachment for Slack", {
                threadId: String(input.threadId),
                messageId: input.messageId,
                attachmentId: attachment.id,
              });
              return null;
            }
            return {
              attachment,
              name: attachment.name,
              mimeType: attachment.mimeType,
              data,
            };
          }),
        { concurrency: 1 },
      ).pipe(
        Effect.map((files) =>
          files.filter(
            (
              file,
            ): file is {
              readonly attachment: ChatAttachment;
              readonly name: string;
              readonly mimeType: string;
              readonly data: Uint8Array;
            } => file !== null,
          ),
        ),
      );
      for (const link of links) {
        if (link.source !== "slack" || link.muted) continue;
        const textDeliveryKey = assistantTextDeliveryKey({
          ...input,
          externalThreadId: link.externalThreadId,
        });
        const existingTextDelivery = yield* repository.getDeliveryReceipt({
          source: "slack",
          deliveryKey: textDeliveryKey,
        });
        if (input.text.trim().length > 0) {
          if (
            Option.isNone(existingTextDelivery) ||
            existingTextDelivery.value.status !== "completed"
          ) {
            const posted = yield* externalChat
              .postToThread({
                source: "slack",
                externalThreadId: link.externalThreadId,
                message: postableReplyBody({
                  kind: "slack_thread",
                  body: input.text,
                }),
              })
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("external intake failed to relay assistant message to Slack", {
                    threadId: String(input.threadId),
                    messageId: input.messageId,
                    externalThreadId: link.externalThreadId,
                    phase: input.phase,
                    error: error instanceof Error ? error.message : String(error),
                  }).pipe(Effect.as(null)),
                ),
              );
            if (posted !== null) {
              yield* repository.upsertDeliveryReceipt({
                source: "slack",
                deliveryKey: textDeliveryKey,
                status: "completed",
                externalMessageId: posted.externalMessageId,
                metadata: {
                  t3ThreadId: String(input.threadId),
                  t3MessageId: input.messageId,
                  t3TurnId: input.turnId,
                  phase: input.phase,
                },
                createdAt: Option.getOrElse(
                  Option.map(existingTextDelivery, (receipt) => receipt.createdAt),
                  () => now,
                ),
                updatedAt: nowIso(),
              });
            }
          }
        }

        if (attachmentFiles.length > 0) {
          const pendingAttachmentFiles: Array<{
            readonly deliveryKey: string;
            readonly existingCreatedAt: string | null;
            readonly attachment: ChatAttachment;
            readonly name: string;
            readonly mimeType: string;
            readonly data: Uint8Array;
          }> = [];
          for (const file of attachmentFiles) {
            const deliveryKey = assistantAttachmentDeliveryKey({
              ...input,
              attachmentId: file.attachment.id,
              externalThreadId: link.externalThreadId,
            });
            const existing = yield* repository.getDeliveryReceipt({
              source: "slack",
              deliveryKey,
            });
            if (Option.isSome(existing) && existing.value.status === "completed") {
              continue;
            }
            pendingAttachmentFiles.push({
              deliveryKey,
              existingCreatedAt: Option.getOrNull(
                Option.map(existing, (receipt) => receipt.createdAt),
              ),
              ...file,
            });
          }
          if (pendingAttachmentFiles.length === 0) {
            continue;
          }
          const uploaded = yield* externalChat
            .uploadFilesToThread({
              source: "slack",
              externalThreadId: link.externalThreadId,
              files: pendingAttachmentFiles.map(({ name, mimeType, data }) => ({
                name,
                mimeType,
                data,
              })),
              ...(input.text.trim().length === 0 ? { initialComment: "Attached files." } : {}),
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("external intake failed to upload assistant files to Slack", {
                  threadId: String(input.threadId),
                  messageId: input.messageId,
                  externalThreadId: link.externalThreadId,
                  phase: input.phase,
                  error: error instanceof Error ? error.message : String(error),
                }).pipe(Effect.as(null)),
              ),
            );
          if (uploaded === null) {
            continue;
          }
          yield* Effect.forEach(
            pendingAttachmentFiles,
            (file, index) =>
              repository.upsertDeliveryReceipt({
                source: "slack",
                deliveryKey: file.deliveryKey,
                status: "completed",
                externalMessageId: uploaded.externalFileIds[index] ?? null,
                metadata: {
                  t3ThreadId: String(input.threadId),
                  t3MessageId: input.messageId,
                  t3TurnId: input.turnId,
                  phase: input.phase,
                  attachment: {
                    id: file.attachment.id,
                    name: file.attachment.name,
                    mimeType: file.attachment.mimeType,
                    sizeBytes: file.attachment.sizeBytes,
                  },
                },
                createdAt: file.existingCreatedAt ?? now,
                updatedAt: nowIso(),
              }),
            { concurrency: 1 },
          );
        }
      }
    });

  const relayFirstAssistantMessage = (state: AssistantTurnRelayState, text: string) =>
    Effect.gen(function* () {
      if (state.firstRelayedText !== null || state.lastMessageId === null) {
        return;
      }
      yield* postAssistantRelayToSlack({
        threadId: state.threadId,
        turnId: state.turnId,
        messageId: state.lastMessageId,
        text,
        phase: "first",
      });
      state.firstRelayedText = text;
    });

  const relayFinalAssistantMessage = (state: AssistantTurnRelayState) =>
    Effect.gen(function* () {
      if (state.lastMessageId === null) {
        return;
      }
      const finalText = normalizedAssistantText(
        state.messageTextById.get(state.lastMessageId) ?? "",
      );
      const attachments = state.messageAttachmentsById.get(state.lastMessageId) ?? [];
      const textToRelay =
        finalText !== null &&
        finalText !== state.firstRelayedText &&
        finalText !== state.finalRelayedText
          ? finalText
          : "";
      if (textToRelay.length === 0 && attachments.length === 0) {
        return;
      }
      if (finalText !== null) {
        yield* recordPullRequests({ threadId: state.threadId, text: finalText });
      }
      yield* postAssistantRelayToSlack({
        threadId: state.threadId,
        turnId: state.turnId,
        messageId: state.lastMessageId,
        text: textToRelay,
        attachments,
        phase: "final",
      });
      if (finalText !== null) {
        state.finalRelayedText = finalText;
      }
    });

  const relayAssistantMessageToSlack = (event: AssistantMessageEvent) =>
    Effect.gen(function* () {
      if (event.payload.role !== "assistant") {
        return;
      }

      const messageId = String(event.payload.messageId);
      const turnId = event.payload.turnId === null ? null : String(event.payload.turnId);
      const key = relayTurnKey({
        threadId: event.payload.threadId,
        turnId,
        messageId,
      });
      const state =
        assistantRelayStateByTurn.get(key) ??
        ({
          threadId: event.payload.threadId as ThreadId,
          turnId,
          firstRelayedText: null,
          finalRelayedText: null,
          lastMessageId: null,
          messageTextById: new Map<string, string>(),
          messageAttachmentsById: new Map<string, ReadonlyArray<ChatAttachment>>(),
        } satisfies AssistantTurnRelayState);
      assistantRelayStateByTurn.set(key, state);

      const text = event.payload.text;
      if (event.payload.attachments !== undefined) {
        state.messageAttachmentsById.set(messageId, event.payload.attachments);
        state.lastMessageId = messageId;
      }
      if (text.length > 0) {
        state.messageTextById.set(
          messageId,
          `${state.messageTextById.get(messageId) ?? ""}${text}`,
        );
        state.lastMessageId = messageId;
        const firstText = normalizedAssistantText(text);
        if (firstText !== null) {
          yield* relayFirstAssistantMessage(state, firstText);
        }
      } else if (event.payload.streaming === false && state.lastMessageId === null) {
        state.lastMessageId = messageId;
      }

      if (
        shouldFinalizeAssistantRelayFromMessage({
          streaming: event.payload.streaming,
          turnId,
          attachments: event.payload.attachments,
        })
      ) {
        yield* relayFinalAssistantMessage(state);
        if (turnId === null) {
          assistantRelayStateByTurn.delete(key);
        }
      }
    });

  const relayUserInputRequestToSlack = (event: ThreadActivityAppendedEvent) =>
    Effect.gen(function* () {
      if (event.payload.activity.kind !== "user-input.requested") {
        return;
      }

      const pending = derivePendingExternalUserInputs([event.payload.activity])[0];
      if (pending === undefined) {
        return;
      }

      const links = yield* repository.listThreadLinksByThread(event.payload.threadId);
      const now = nowIso();
      for (const link of links) {
        if (link.source !== "slack" || link.muted) continue;
        const deliveryKey = `user-input-request:${String(pending.requestId)}:${link.externalThreadId}`;
        const existing = yield* repository.getDeliveryReceipt({
          source: "slack",
          deliveryKey,
        });
        if (Option.isSome(existing) && existing.value.status === "completed") {
          continue;
        }

        const posted = yield* externalChat
          .postToThread({
            source: "slack",
            externalThreadId: link.externalThreadId,
            message: postableUserInputRequest({
              kind: "slack_thread",
              questions: pending.questions,
            }),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("external intake failed to relay user input request to Slack", {
                threadId: String(event.payload.threadId),
                requestId: String(pending.requestId),
                externalThreadId: link.externalThreadId,
                error: error instanceof Error ? error.message : String(error),
              }).pipe(Effect.as(null)),
            ),
          );
        if (posted === null) {
          continue;
        }

        yield* repository.upsertDeliveryReceipt({
          source: "slack",
          deliveryKey,
          status: "completed",
          externalMessageId: posted.externalMessageId,
          metadata: {
            t3ThreadId: String(event.payload.threadId),
            requestId: String(pending.requestId),
          },
          createdAt: Option.getOrElse(
            Option.map(existing, (receipt) => receipt.createdAt),
            () => now,
          ),
          updatedAt: nowIso(),
        });
      }
    });

  const finalizeAssistantTurnsForThread = (event: ThreadSessionSetEvent) =>
    Effect.gen(function* () {
      if (event.payload.session.status === "running") {
        return;
      }
      const threadId = String(event.payload.threadId);
      const matchingEntries = [...assistantRelayStateByTurn.entries()].filter(
        ([, state]) => String(state.threadId) === threadId,
      );
      for (const [key, state] of matchingEntries) {
        yield* relayFinalAssistantMessage(state);
        assistantRelayStateByTurn.delete(key);
      }
    });

  yield* Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (event.type === "thread.session-set") {
        return finalizeAssistantTurnsForThread(event).pipe(
          Effect.catch((error) =>
            Effect.logWarning("external intake reactor failed to finalize Slack assistant relay", {
              eventId: String(event.eventId),
              threadId: String(event.payload.threadId),
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }

      if (event.type === "thread.activity-appended") {
        return relayUserInputRequestToSlack(event).pipe(
          Effect.catch((error) =>
            Effect.logWarning("external intake reactor failed to relay user input request", {
              eventId: String(event.eventId),
              threadId: String(event.payload.threadId),
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }

      if (event.type !== "thread.message-sent" || event.payload.role !== "assistant") {
        return Effect.void;
      }
      return Effect.all(
        [
          shouldRelayAssistantMessage(event)
            ? recordPullRequests({
                threadId: event.payload.threadId as ThreadId,
                text: event.payload.text,
              })
            : Effect.void,
          relayAssistantMessageToSlack(event),
        ],
        {
          concurrency: 2,
        },
      ).pipe(
        Effect.catch((error) =>
          Effect.logWarning("external intake reactor failed to process assistant message", {
            eventId: String(event.eventId),
            threadId: String(event.payload.threadId),
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
    }),
  );
});

export const ExternalIntakeReactorLive = Layer.effectDiscard(makeExternalIntakeReactor);
