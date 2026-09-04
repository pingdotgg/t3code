import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  ServerConfig,
  ServerProviderSessionFork,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

export function visibleTopLevelThreads<
  T extends Pick<EnvironmentThreadShell, "fork" | "id" | "sideChat">,
>(threads: ReadonlyArray<T>, knownThreadIds: ReadonlySet<ThreadId>): T[] {
  return threads.filter((thread) => {
    const sourceThreadId = thread.fork?.sourceThreadId;
    return (
      thread.sideChat !== true ||
      sourceThreadId === undefined ||
      !knownThreadIds.has(sourceThreadId)
    );
  });
}

export function resolveMobileThreadForkCapability(
  thread: Pick<EnvironmentThreadShell, "modelSelection" | "session">,
  serverConfig: ServerConfig | null,
): ServerProviderSessionFork | undefined {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  return serverConfig?.providers.find((provider) => provider.instanceId === instanceId)
    ?.sessionFork;
}

export function resolveMobileLatestCompletedTurnId(
  latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state" | "completedAt"> | null | undefined,
): TurnId | null {
  return latestTurn?.state === "completed" && latestTurn.completedAt !== null
    ? latestTurn.turnId
    : null;
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

export function canForkMobileAssistantMessage(input: {
  readonly capability: ServerProviderSessionFork | undefined;
  readonly completed: boolean;
  readonly completedTurnIds: ReadonlySet<TurnId>;
  readonly messageTurnId: TurnId | null;
  readonly latestTurn:
    | Pick<OrchestrationLatestTurn, "turnId" | "state" | "completedAt">
    | null
    | undefined;
}): boolean {
  if (!input.completed || input.messageTurnId === null) return false;
  if (
    input.latestTurn?.turnId === input.messageTurnId &&
    resolveMobileLatestCompletedTurnId(input.latestTurn) !== input.messageTurnId
  ) {
    return false;
  }
  if (input.capability === "any-turn") return input.completedTurnIds.has(input.messageTurnId);
  return (
    input.capability === "latest-turn" &&
    input.messageTurnId === resolveMobileLatestCompletedTurnId(input.latestTurn)
  );
}

export interface MobileSideChatMenuItem {
  readonly id: `side-chat:${ThreadId}`;
  readonly title: string;
}

export function buildMobileSideChatMenuItems(input: {
  readonly sideChats: ReadonlyArray<Pick<EnvironmentThreadShell, "id" | "title">>;
}): MobileSideChatMenuItem[] {
  return input.sideChats.map((sideChat) => ({
    id: `side-chat:${sideChat.id}`,
    title: sideChat.title,
  }));
}
