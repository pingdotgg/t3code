import * as DateTime from "effect/DateTime";

interface SnoozeFields {
  readonly snoozedUntil?: DateTime.Utc | null | undefined;
  readonly snoozedAt?: DateTime.Utc | null | undefined;
}

/** A snooze stays stored after its wake time passes, until something clears it. */
export function hasStoredSnooze(thread: SnoozeFields): boolean {
  return thread.snoozedUntil != null || thread.snoozedAt != null;
}

/** Whether a stored snooze still holds; one with no wake time holds until the thread is woken. */
export function snoozeHolds(thread: SnoozeFields, nowMs: number): boolean {
  return thread.snoozedUntil == null
    ? thread.snoozedAt != null
    : DateTime.toEpochMillis(thread.snoozedUntil) > nowMs;
}
