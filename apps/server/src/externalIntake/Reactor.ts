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
import { postableReplyBody } from "./postableReply.ts";

type AssistantMessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

function nowIso() {
  return DateTime.formatIso(DateTime.toUtc(DateTime.nowUnsafe()));
}

function shouldRelayAssistantMessage(event: AssistantMessageEvent) {
  return event.payload.role === "assistant" && event.payload.text.trim().length > 0;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const repository = yield* ExternalIntegrationRepository;
  const externalChat = yield* ExternalChat;

  const recordPullRequests = (event: AssistantMessageEvent) =>
    Effect.gen(function* () {
      const now = nowIso();
      for (const pullRequest of extractGitHubPullRequests(event.payload.text)) {
        yield* repository.upsertArtifactLink({
          kind: "github_pr",
          externalId: pullRequest.externalId,
          t3ThreadId: event.payload.threadId,
          url: pullRequest.url,
          metadata: pullRequest,
          createdAt: now,
          updatedAt: now,
        });
      }
    });

  const relayAssistantToSlack = (event: AssistantMessageEvent) =>
    Effect.gen(function* () {
      if (!shouldRelayAssistantMessage(event)) {
        return;
      }
      const links = yield* repository.listThreadLinksByThread(event.payload.threadId as ThreadId);
      const now = nowIso();
      for (const link of links) {
        if (link.source !== "slack" || link.muted) continue;
        const deliveryKey = `assistant-message:${String(event.payload.messageId)}:${link.externalThreadId}`;
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
              body: event.payload.text,
            }),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("external intake failed to relay assistant message to Slack", {
                threadId: String(event.payload.threadId),
                messageId: String(event.payload.messageId),
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
            t3MessageId: String(event.payload.messageId),
          },
          createdAt: Option.getOrElse(
            Option.map(existing, (receipt) => receipt.createdAt),
            () => now,
          ),
          updatedAt: nowIso(),
        });
      }
    });

  yield* Effect.forkScoped(
    Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      if (event.type !== "thread.message-sent" || event.payload.role !== "assistant") {
        return Effect.void;
      }
      return Effect.all([recordPullRequests(event), relayAssistantToSlack(event)], {
        concurrency: 2,
      }).pipe(
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
