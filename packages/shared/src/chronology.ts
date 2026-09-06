import { compareDateTimeStrings } from "./dateTime.ts";

interface CreatedEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly createdSequence?: number | undefined;
}

/** Legacy snapshots form a timestamp-ordered prefix before newly persisted events. */
export function compareCreatedOrder(left: CreatedEntry, right: CreatedEntry): number {
  return (
    (left.createdSequence ?? 0) - (right.createdSequence ?? 0) ||
    compareDateTimeStrings(left.createdAt, right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

/** Capture once when a local message is sent, before the next persisted event. */
export function nextLocalMessageSequence(thread: {
  readonly messages: ReadonlyArray<{ readonly createdSequence?: number | undefined }>;
  readonly activities: ReadonlyArray<{ readonly createdSequence?: number | undefined }>;
  readonly proposedPlans?: ReadonlyArray<{ readonly createdSequence?: number | undefined }>;
}): number | undefined {
  let latest: number | undefined;
  for (const entries of [thread.messages, thread.activities, thread.proposedPlans ?? []]) {
    for (const entry of entries) {
      if (entry.createdSequence !== undefined) {
        latest = Math.max(latest ?? 0, entry.createdSequence);
      }
    }
  }
  return latest === undefined ? undefined : latest + 1;
}
