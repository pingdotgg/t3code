import type { OrchestrationLatestTurn, OrchestrationThreadActivity } from "@t3tools/contracts";

export interface ConnectionRecoveryNotice {
  readonly kind: "waiting" | "resumed" | "failed" | "stop-failed";
  readonly label: string;
  readonly expiresAt: number | null;
}

/** Recovery activities belong to the temporary notice, never the conversation feed. */
export function isConnectionRecoveryActivity(kind: string): boolean {
  return kind === "connection.interrupted" || kind.startsWith("connection.recovery.");
}

/** Derive only server-confirmed recovery; a connected socket does not prove task recovery. */
export function deriveConnectionRecoveryNotice(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly enabled: boolean;
  readonly pendingRequest: boolean;
  readonly now: number;
}): ConnectionRecoveryNotice | null {
  if (input.pendingRequest || input.latestTurn === null) return null;
  let latest: OrchestrationThreadActivity | undefined;
  for (const activity of input.activities) {
    if (!activity.kind.startsWith("connection.recovery.")) continue;
    if (
      latest === undefined ||
      (activity.sequence !== undefined && latest.sequence !== undefined
        ? activity.sequence > latest.sequence
        : activity.createdAt >= latest.createdAt)
    )
      latest = activity;
  }
  if (latest === undefined) return null;
  const payload = latest.payload;
  const resumedTurnId =
    typeof payload === "object" && payload !== null && "resumedTurnId" in payload
      ? payload.resumedTurnId
      : null;
  if (latest.kind === "connection.recovery.resumed") {
    const expiresAt = Date.parse(latest.createdAt) + 5_000;
    if (
      resumedTurnId !== input.latestTurn.turnId ||
      !Number.isFinite(expiresAt) ||
      input.now >= expiresAt ||
      input.latestTurn.state === "interrupted" ||
      input.latestTurn.state === "error"
    )
      return null;
    return { kind: "resumed", label: "Task resumed", expiresAt };
  }
  if (
    (latest.turnId !== input.latestTurn.turnId && resumedTurnId !== input.latestTurn.turnId) ||
    input.latestTurn.state === "completed"
  )
    return null;
  if (
    latest.kind === "connection.recovery.failed" &&
    typeof payload === "object" &&
    payload !== null &&
    "reason" in payload &&
    payload.reason === "cancellation-failed"
  ) {
    return {
      kind: "stop-failed",
      label: "Could not stop automatic recovery. Use Stop before continuing.",
      expiresAt: null,
    };
  }
  if (input.latestTurn.state === "running") return null;
  if (latest.kind === "connection.recovery.waiting" && input.enabled) {
    return { kind: "waiting", label: "Connection lost. Waiting to resume…", expiresAt: null };
  }
  if (latest.kind === "connection.recovery.failed") {
    return {
      kind: "failed",
      label:
        typeof payload === "object" &&
        payload !== null &&
        "reason" in payload &&
        payload.reason === "unsupported"
          ? "This provider can't resume automatically. Continue the task manually."
          : "Couldn't resume automatically. Continue the task manually.",
      expiresAt: null,
    };
  }
  return null;
}
