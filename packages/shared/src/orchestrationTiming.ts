type LatestTurnTiming = {
  readonly turnId: string | null;
  /** Set when the turn is created; `startedAt` waits for the provider. */
  readonly requestedAt?: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
};

type SessionActivityState = {
  readonly orchestrationStatus: string;
  readonly activeTurnId?: string | null;
};

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.orchestrationStatus === "running") return false;
  return true;
}

/**
 * When the working indicator should be counting, and from when.
 *
 * `requestedAt` is the floor for an unsettled turn. The projector only stamps
 * `startedAt` in the same update that moves the session to "running", so while
 * the provider spins up (session "starting") a requested turn has no
 * `startedAt` at all — and returning null there blinks the indicator out for
 * the whole spin-up. A settled turn still falls through to `sendStartedAt`, so
 * this cannot leave the indicator counting after the work is done.
 */
export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
): string | null {
  if (session?.activeTurnId && session.activeTurnId !== latestTurn?.turnId) {
    return sendStartedAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? latestTurn?.requestedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}
