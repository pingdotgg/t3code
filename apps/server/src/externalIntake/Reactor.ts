import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

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

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const repository = yield* ExternalIntegrationRepository;
  const externalChat = yield* ExternalChat;
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
    readonly phase: "first" | "final";
  }) =>
    Effect.gen(function* () {
      const links = yield* repository.listThreadLinksByThread(input.threadId);
      const now = nowIso();
      for (const link of links) {
        if (link.source !== "slack" || link.muted) continue;
        const deliveryKey = `assistant-message:${input.phase}:${relayTurnKey(input)}:${link.externalThreadId}`;
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
        if (posted === null) {
          continue;
        }
        yield* repository.upsertDeliveryReceipt({
          source: "slack",
          deliveryKey,
          status: "completed",
          externalMessageId: posted.externalMessageId,
          metadata: {
            t3ThreadId: String(input.threadId),
            t3MessageId: input.messageId,
            t3TurnId: input.turnId,
            phase: input.phase,
          },
          createdAt: Option.getOrElse(
            Option.map(existing, (receipt) => receipt.createdAt),
            () => now,
          ),
          updatedAt: nowIso(),
        });
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
      if (state.lastMessageId === null || state.finalRelayedText !== null) {
        return;
      }
      const finalText = normalizedAssistantText(
        state.messageTextById.get(state.lastMessageId) ?? "",
      );
      if (finalText === null || finalText === state.firstRelayedText) {
        return;
      }
      yield* recordPullRequests({ threadId: state.threadId, text: finalText });
      yield* postAssistantRelayToSlack({
        threadId: state.threadId,
        turnId: state.turnId,
        messageId: state.lastMessageId,
        text: finalText,
        phase: "final",
      });
      state.finalRelayedText = finalText;
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
        } satisfies AssistantTurnRelayState);
      assistantRelayStateByTurn.set(key, state);

      const text = event.payload.text;
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

      if (event.payload.streaming === false && turnId === null) {
        yield* relayFinalAssistantMessage(state);
        assistantRelayStateByTurn.delete(key);
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

export const ExternalIntakeReactorLive = Layer.effectDiscard(make);
