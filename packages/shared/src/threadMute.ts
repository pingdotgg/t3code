import * as DateTime from "effect/DateTime";

type Instant = DateTime.Utc | string | null | undefined;

export interface ThreadMuteFields {
  readonly mutedAt?: Instant;
  /** Absent or null while muted means the mute lasts until the user unmutes. */
  readonly mutedUntil?: Instant;
}

function toMillis(value: Instant): number | null {
  if (value == null) return null;
  const ms = typeof value === "string" ? Date.parse(value) : DateTime.toEpochMillis(value);
  return Number.isNaN(ms) ? null : ms;
}

/** The mute is in effect at `nowMs`. A timed mute expires without an event. */
export function isThreadMuted(thread: ThreadMuteFields, nowMs: number): boolean {
  if (toMillis(thread.mutedAt) === null) return false;
  const untilMs = toMillis(thread.mutedUntil);
  return untilMs === null || nowMs < untilMs;
}

/**
 * A run that finished before the latest mute ended never alerts or shows Done, so ending a mute
 * cannot replay what it silenced. Unmuting records its time as the end instead of clearing it.
 */
export function isMutedCompletion(thread: ThreadMuteFields, completedAt: Instant): boolean {
  const completedAtMs = toMillis(completedAt);
  if (completedAtMs === null || toMillis(thread.mutedAt) === null) return false;
  const untilMs = toMillis(thread.mutedUntil);
  return untilMs === null || completedAtMs < untilMs;
}

/** When the mute in effect at `nowMs` ends: null while it lasts until unmuted, undefined when not muted. */
export function threadMuteEndsAt(
  thread: ThreadMuteFields,
  nowMs: number,
): number | null | undefined {
  if (!isThreadMuted(thread, nowMs)) return undefined;
  return toMillis(thread.mutedUntil);
}
