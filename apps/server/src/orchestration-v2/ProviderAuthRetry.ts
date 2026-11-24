import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import {
  CommandId,
  MessageId,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { cancelledBeforeStart } from "./RestartBackgroundNote.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const RETRY_MESSAGE_PREFIX = "message:auth-retry:";

const AUTH_REJECTION_CODES = new Set(["api_error_401", "api_error_403"]);
// Codex and OpenCode only pass the gateway's text through. LiteLLM answers an
// expired or revoked key with "Authentication Error, ..." and HTTP 401.
// A bare 401 or "unauthorized" is too common in tool output to count.
const AUTH_REJECTION_TEXT =
  /\bstatus(?:\s*code)?\b\W{0,3}40[13]\b|\b40[13]\s+(?:unauthori[sz]ed|forbidden)\b|authentication error|invalid proxy server token|token expired/i;

export const isGatewayAuthRejection = (failure: OrchestrationV2ProviderFailure): boolean =>
  (failure.code !== null && AUTH_REJECTION_CODES.has(failure.code)) ||
  AUTH_REJECTION_TEXT.test(failure.message);

// Sending the message again is only safe when the failed turn changed nothing:
// a gateway 401 normally arrives on the first model call, before any tool.
const HARMLESS_TURN_ITEMS: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
  "error",
  "system_notice",
  "checkpoint",
]);

const turnHadSideEffects = (items: ReadonlyArray<OrchestrationV2TurnItem>): boolean =>
  items.some((item) => !HARMLESS_TURN_ITEMS.has(item.type));

/**
 * Providers that keep the key they started with (LiteLLM instances) fail once
 * that key expires. Replace the session, which makes the next process read the
 * renewed key, and send the user's message again, once.
 */
export const retryAfterGatewayAuthRejection = Effect.fn(
  "ProviderAuthRetry.retryAfterGatewayAuthRejection",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly sourceRunId: RunId;
  readonly providerSessionId: ProviderSessionId;
}) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const messageId = MessageId.make(`${RETRY_MESSAGE_PREFIX}${input.sourceRunId}`);
  const projection = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
    messageIds: [messageId],
  });
  if (projection.messages.some((message) => message.id === messageId)) return;
  const source = projection.runs.find((run) => run.id === input.sourceRunId);
  if (
    source === undefined ||
    source.status !== "failed" ||
    // A retry that fails the same way is the user's to see, not another retry.
    String(source.userMessageId).startsWith(RETRY_MESSAGE_PREFIX) ||
    projection.thread.providerInstanceId !== source.providerInstanceId ||
    projection.runs.some(
      (run) =>
        run.id !== source.id &&
        run.status !== "queued" &&
        !cancelledBeforeStart(run) &&
        runRanAfter(run, source),
    )
  )
    return;
  if (!(yield* providerSessions.keepsStartupCredentials(source.providerInstanceId))) return;
  const sourceRecords = yield* threads.getThreadRecords(input.threadId, ["messages", "turnItems"], {
    messageIds: [source.userMessageId],
    turnItemRunIds: [source.id],
  });
  if (turnHadSideEffects(sourceRecords.turnItems.filter((item) => item.runId === source.id)))
    return;
  const sourceMessage = sourceRecords.messages.find(
    (message) => message.id === source.userMessageId,
  );
  if (sourceMessage === undefined) return;

  // Codex runs every thread in one process: never stop another thread's turn to retry this one.
  const replaced = yield* providerSessions.releaseIfIdle({
    providerSessionId: input.providerSessionId,
    reason: "credentials_renewed",
    detail: "The gateway rejected the session's key.",
  });
  if (!replaced) return;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:auth-retry:${input.sourceRunId}`),
    threadId: input.threadId,
    messageId,
    text: sourceMessage.text,
    ...(sourceMessage.context === undefined ? {} : { context: sourceMessage.context }),
    attachments: sourceMessage.attachments,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: "The gateway key expired. HYR Code renewed it and sent your message again",
      detail: sourceMessage.text,
    },
    modelSelection: source.modelSelection,
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  });
});
