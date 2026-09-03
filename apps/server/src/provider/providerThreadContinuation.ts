import type {
  OrchestrationThread,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderSendTurnInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionThreadMessageRepositoryShape } from "../persistence/Services/ProjectionThreadMessages.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

export const EXPLICIT_PROVIDER_CONTINUATION_PROMPT = "Continue where you left off.";

/** Uses the provider continuation capability added for server-update recovery. */
export const continueProviderThread = Effect.fn("continueProviderThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly interactionMode: ProviderInteractionMode;
  readonly getCapabilities: ProviderServiceShape["getCapabilities"];
  readonly sendTurn: ProviderServiceShape["sendTurn"];
  readonly fallbackTurn?: Pick<ProviderSendTurnInput, "input" | "attachments"> | undefined;
}) {
  const capabilities = yield* input.getCapabilities(input.instanceId);
  yield* input.sendTurn({
    threadId: input.threadId,
    ...(capabilities.promptlessTurnContinuation === true
      ? { continuation: true }
      : (input.fallbackTurn ?? { input: EXPLICIT_PROVIDER_CONTINUATION_PROMPT })),
    interactionMode: input.interactionMode,
  });
});

function failedTurnInput(message: {
  readonly text: string;
  readonly attachments?: ProviderSendTurnInput["attachments"] | undefined;
}): Pick<ProviderSendTurnInput, "input" | "attachments"> | undefined {
  const attachments = message.attachments ?? [];
  if (message.text.trim().length === 0 && attachments.length === 0) return undefined;
  return {
    ...(message.text.trim().length === 0 ? {} : { input: message.text }),
    ...(attachments.length === 0 ? {} : { attachments }),
  };
}

function matchesAuthenticationError(
  thread: OrchestrationThread,
  instanceId: ProviderInstanceId,
): boolean {
  const session = thread.session;
  return (
    session !== undefined &&
    session !== null &&
    session.status === "error" &&
    session.lastErrorClass === "auth_error" &&
    (session.providerInstanceId ?? thread.modelSelection.instanceId) === instanceId &&
    thread.latestTurn?.state === "error"
  );
}

/**
 * Continues the thread that prompted a provider reauthentication attempt.
 * A later user turn clears the authentication error, so the guard also keeps
 * a delayed browser callback from steering work the user already restarted.
 */
export const continueProviderThreadAfterReauthentication = Effect.fn(
  "continueProviderThreadAfterReauthentication",
)(function* (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"];
  readonly getTurnByTurnId: ProjectionTurnRepositoryShape["getByTurnId"];
  readonly getPendingTurnStartByThreadId: ProjectionTurnRepositoryShape["getPendingTurnStartByThreadId"];
  readonly getMessageById: ProjectionThreadMessageRepositoryShape["getByMessageId"];
  readonly getCapabilities: ProviderServiceShape["getCapabilities"];
  readonly sendTurn: ProviderServiceShape["sendTurn"];
}) {
  const thread = Option.getOrUndefined(
    yield* input.getThreadDetailById(input.threadId, { activityKinds: [] }),
  );
  if (thread === undefined || !matchesAuthenticationError(thread, input.instanceId)) {
    return false;
  }

  const latestTurn = thread.latestTurn;
  if (latestTurn === null) return false;
  const turn = Option.getOrUndefined(
    yield* input.getTurnByTurnId({ threadId: thread.id, turnId: latestTurn.turnId }),
  );
  if (turn === undefined || turn.state !== "error" || turn.pendingMessageId === null) return false;
  const pendingMessageId = turn.pendingMessageId;

  const message = Option.getOrUndefined(
    yield* input.getMessageById({ messageId: pendingMessageId }),
  );
  if (message === undefined || message.threadId !== thread.id || message.role !== "user") {
    return false;
  }
  const fallbackTurn = failedTurnInput(message);
  if (fallbackTurn === undefined) return false;

  // Re-read just before sending so a user turn that landed while the browser
  // auth flow was open wins instead of being steered with a replayed prompt.
  const [currentThreadOption, pendingTurnStart] = yield* Effect.all([
    input.getThreadDetailById(input.threadId, { activityKinds: [] }),
    input.getPendingTurnStartByThreadId({ threadId: input.threadId }),
  ]);
  const currentThread = Option.getOrUndefined(currentThreadOption);
  if (
    currentThread === undefined ||
    !matchesAuthenticationError(currentThread, input.instanceId) ||
    currentThread.latestTurn?.turnId !== latestTurn.turnId ||
    currentThread.messages.findLast((candidate) => candidate.role === "user")?.id !==
      pendingMessageId ||
    Option.isSome(pendingTurnStart)
  ) {
    return false;
  }

  yield* continueProviderThread({
    threadId: thread.id,
    instanceId: input.instanceId,
    interactionMode: thread.interactionMode,
    getCapabilities: input.getCapabilities,
    sendTurn: input.sendTurn,
    fallbackTurn,
  });
  return true;
});
