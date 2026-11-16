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
 * The run finished inside the latest mute, so it never alerts or shows Done. A run that finished
 * before the mute began keeps its Done marker. Unmuting records its time as the end, so the
 * window survives the unmute.
 */
export function isMutedCompletion(thread: ThreadMuteFields, completedAt: Instant): boolean {
  return isDuringMute(thread, completedAt);
}

/** The instant falls inside the latest mute, from its start up to its end. */
export function isDuringMute(thread: ThreadMuteFields, at: Instant): boolean {
  const atMs = toMillis(at);
  const mutedAtMs = toMillis(thread.mutedAt);
  if (atMs === null || mutedAtMs === null) return false;
  return atMs >= mutedAtMs && finishedBeforeMuteEnd(thread, at);
}

/**
 * The latest of these run times that falls outside the latest mute, or the thread's recorded
 * `unmutedRunAt` if later. The server records this when a mute starts, so a thread keeps its
 * place in the list through runs that start or finish while it is muted.
 */
export function latestUnmutedRunAt(
  thread: ThreadMuteFields & { readonly unmutedRunAt?: Instant },
  runTimes: ReadonlyArray<Instant>,
): number | null {
  let latest = toMillis(thread.unmutedRunAt);
  for (const at of runTimes) {
    const atMs = toMillis(at);
    if (atMs === null || isDuringMute(thread, at)) continue;
    if (latest === null || atMs > latest) latest = atMs;
  }
  return latest;
}

/**
 * The run finished before the latest mute ended, inside it or earlier. Push alerts use this,
 * so ending a mute never re-sends an alert the mute cleared.
 */
export function finishedBeforeMuteEnd(thread: ThreadMuteFields, completedAt: Instant): boolean {
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
