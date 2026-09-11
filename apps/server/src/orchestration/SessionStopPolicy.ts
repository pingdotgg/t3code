import type {
  OrchestrationLatestTurnState,
  OrchestrationSession,
  ProviderDriverKind,
} from "@t3tools/contracts";

const idleSessionStatuses = new Set<OrchestrationSession["status"]>([
  "ready",
  "idle",
  "interrupted",
  "error",
]);

export function canStopThreadSessionIfIdle(input: {
  readonly expectedProviderName: ProviderDriverKind | undefined;
  readonly session: OrchestrationSession | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly hasQueuedTurnStart: boolean;
  readonly hasPendingRequests: boolean;
  readonly backgroundLiveness: "working" | "monitoring" | null;
}): boolean {
  return (
    input.expectedProviderName === "codex" &&
    input.session !== null &&
    input.session.providerName === "codex" &&
    idleSessionStatuses.has(input.session.status) &&
    input.session.activeTurnId === null &&
    input.latestTurnState !== "running" &&
    !input.hasQueuedTurnStart &&
    !input.hasPendingRequests &&
    input.backgroundLiveness === null
  );
}
