import type {
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  ServerProviderSessionFork,
  TurnId,
} from "@t3tools/contracts";

export type ForkCapability = ServerProviderSessionFork | undefined;

export interface ThreadForkTarget {
  readonly turnId: TurnId;
  readonly messageId: MessageId;
}

export function completedTurnIdsFromCheckpoints(
  checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "status" | "turnId">>,
): ReadonlySet<TurnId> {
  return new Set(
    checkpoints
      .filter((checkpoint) => checkpoint.status === "ready")
      .map((checkpoint) => checkpoint.turnId),
  );
}

export function resolveLatestCompletedForkTarget(
  latestTurn: OrchestrationLatestTurn | null | undefined,
): ThreadForkTarget | null {
  if (
    latestTurn?.state !== "completed" ||
    latestTurn.completedAt === null ||
    latestTurn.assistantMessageId === null
  ) {
    return null;
  }
  return {
    turnId: latestTurn.turnId,
    messageId: latestTurn.assistantMessageId,
  };
}

function resolveLatestCompletedMessageTarget(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "id" | "role" | "streaming" | "turnId">>,
  excludedTurnId: TurnId,
  completedTurnIds: ReadonlySet<TurnId>,
): ThreadForkTarget | null {
  const message = messages.findLast(
    (candidate) =>
      candidate.role === "assistant" &&
      !candidate.streaming &&
      candidate.turnId !== null &&
      candidate.turnId !== excludedTurnId &&
      completedTurnIds.has(candidate.turnId),
  );
  return message?.turnId ? { turnId: message.turnId, messageId: message.id } : null;
}

export function resolveForkEntryAvailability(input: {
  readonly capability: ForkCapability;
  readonly latestTurn: OrchestrationLatestTurn | null | undefined;
  readonly messages?: ReadonlyArray<
    Pick<OrchestrationMessage, "id" | "role" | "streaming" | "turnId">
  >;
  readonly completedTurnIds?: ReadonlySet<TurnId>;
}): {
  readonly enabled: boolean;
  readonly target: ThreadForkTarget | null;
  readonly disabledReason: string | null;
} {
  const latestTarget = resolveLatestCompletedForkTarget(input.latestTurn);
  if (input.capability === undefined || input.capability === "unsupported") {
    return {
      enabled: false,
      target: latestTarget,
      disabledReason: "The active provider does not support forking.",
    };
  }
  const target =
    latestTarget ??
    (input.capability === "any-turn" &&
    input.latestTurn != null &&
    input.latestTurn.state !== "completed"
      ? resolveLatestCompletedMessageTarget(
          input.messages ?? [],
          input.latestTurn.turnId,
          input.completedTurnIds ?? new Set(),
        )
      : null);
  if (target === null) {
    // The sidebar builds its menu from the thread shell alone, so an unopened
    // thread carries no messages to search for an earlier completed turn.
    // Say what to do instead of claiming no turn has completed.
    const earlierTurnUnknown =
      input.messages === undefined &&
      input.capability === "any-turn" &&
      input.latestTurn != null &&
      input.latestTurn.state !== "completed";
    return {
      enabled: false,
      target: null,
      disabledReason: earlierTurnUnknown
        ? "Open this thread to fork an earlier response."
        : "Complete a turn before forking this thread.",
    };
  }
  return { enabled: true, target, disabledReason: null };
}

export function canForkCompletedAssistantMessage(input: {
  readonly capability: ForkCapability;
  readonly completed: boolean;
  readonly messageTurnId: TurnId | null;
  readonly latestCompletedTurnId: TurnId | null;
  readonly completedTurnIds: ReadonlySet<TurnId>;
}): boolean {
  if (!input.completed || input.messageTurnId === null) return false;
  if (input.capability === undefined || input.capability === "unsupported") return false;
  if (input.messageTurnId === input.latestCompletedTurnId) return true;
  // Older turns need a ready checkpoint to prove they finished: a finalized
  // assistant row can also belong to an interrupted or failed turn, which the
  // server refuses to fork. Same rule as the header and palette entry points.
  return input.capability === "any-turn" && input.completedTurnIds.has(input.messageTurnId);
}

export async function runPromoteSideChat(input: {
  readonly update: () => Promise<boolean>;
  readonly closeSurface: () => void;
  readonly navigate: () => Promise<void>;
}): Promise<boolean> {
  if (!(await input.update())) return false;
  input.closeSurface();
  await input.navigate();
  return true;
}
