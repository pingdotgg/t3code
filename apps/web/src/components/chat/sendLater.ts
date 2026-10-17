import * as DateTime from "effect/DateTime";

export const SEND_LATER_DELAYS = [
  { label: "In 1 minute", delayMs: 60_000 },
  { label: "In 2 minutes", delayMs: 2 * 60_000 },
  { label: "In 5 minutes", delayMs: 5 * 60_000 },
] as const;

// Mirrors the delay range `message.dispatch` accepts, so the field never offers
// a delay the server would reject.
export const SEND_LATER_CUSTOM_MINUTES = { min: 1, max: 60, default: 10 } as const;

/** The delay for a custom number of whole minutes, or null when it is outside the accepted range. */
export function parseSendLaterMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const minutes = Number(trimmed);
  if (minutes < SEND_LATER_CUSTOM_MINUTES.min || minutes > SEND_LATER_CUSTOM_MINUTES.max) {
    return null;
  }
  return minutes * 60_000;
}

/**
 * Delayed sends ride the existing-thread `message.dispatch` path. Thread
 * creation and worktree bootstrap launch through a separate command that has no
 * hold, and an older server would drop `delayMs` and send at once, so every
 * other path keeps the instant send only.
 */
export function canSendLater(input: {
  readonly serverSupportsDelayedMessages: boolean;
  readonly isServerThread: boolean;
  readonly needsThreadBootstrap: boolean;
  readonly sendQueuesBehindSetup: boolean;
}): boolean {
  return (
    input.serverSupportsDelayedMessages &&
    input.isServerThread &&
    !input.needsThreadBootstrap &&
    !input.sendQueuesBehindSetup
  );
}

/** The ISO time a queued run is held until, or null once it is released. */
export function queuedRunReleaseIso(run: {
  readonly releaseAt?: DateTime.Utc | string | null | undefined;
}): string | null {
  const releaseAt = run.releaseAt;
  if (releaseAt === null || releaseAt === undefined) return null;
  return typeof releaseAt === "string" ? releaseAt : DateTime.formatIso(releaseAt);
}

/**
 * The steer shortcut promotes the oldest queued message. A delayed message is
 * skipped so the shortcut cannot send it before its time; its own Send now
 * button is the only early release.
 */
export function firstSteerableQueuedRun<
  T extends { readonly run: Parameters<typeof queuedRunReleaseIso>[0] },
>(queued: ReadonlyArray<T>): T | undefined {
  return queued.find((entry) => queuedRunReleaseIso(entry.run) === null);
}
