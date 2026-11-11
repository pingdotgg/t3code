import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, OwnedWorkItemId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Durable owned work on a thread: assign → claim → progress → handoff → close.
 * Closing stores delivery (`closureReason`), not acceptance of the next stage.
 */
export const OwnedWorkItemStatus = Schema.Literals([
  "assigned",
  "claimed",
  "in_progress",
  "handed_off",
  "completed",
  "cancelled",
]);
export type OwnedWorkItemStatus = typeof OwnedWorkItemStatus.Type;

export const OPEN_OWNED_WORK_STATUSES: ReadonlySet<OwnedWorkItemStatus> = new Set([
  "assigned",
  "claimed",
  "in_progress",
  "handed_off",
]);

/** Where finished owned work went. `handed_off` / `escalation` also need `closureTarget`. */
export const OwnedWorkClosureReason = Schema.Literals([
  "handed_off",
  "denied",
  "canceled",
  "no_follow_on",
  "escalation",
  "superseded",
]);
export type OwnedWorkClosureReason = typeof OwnedWorkClosureReason.Type;

const CLOSURE_REASONS_REQUIRING_TARGET: ReadonlySet<OwnedWorkClosureReason> = new Set([
  "handed_off",
  "escalation",
]);

export const OwnedWorkItem = Schema.Struct({
  id: OwnedWorkItemId,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  status: OwnedWorkItemStatus,
  /** Who should pick this up; null means any teammate on the home thread may claim. */
  assigneeThreadId: Schema.NullOr(ThreadId),
  claimedByThreadId: Schema.NullOr(ThreadId),
  progress: Schema.NullOr(Schema.String),
  /** Last handoff note, when ownership was passed to another assignee. */
  handoffNote: Schema.NullOr(Schema.String),
  /** Set only when the item is completed or cancelled. Absent on pre-closure-reason rows. */
  closureReason: Schema.optional(Schema.NullOr(OwnedWorkClosureReason)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Destination seat/thread/item for `handed_off` and `escalation`. */
  closureTarget: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Optional note recorded with the close. */
  closureNote: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdByThreadId: ThreadId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  claimedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OwnedWorkItem = typeof OwnedWorkItem.Type;

export const openOwnedWorkCount = (
  items: ReadonlyArray<OwnedWorkItem> | null | undefined,
): number => items?.filter((item) => OPEN_OWNED_WORK_STATUSES.has(item.status)).length ?? 0;

/** Returns an error message when close input is incomplete; otherwise null. */
export const ownedWorkClosureError = (input: {
  readonly closureReason: OwnedWorkClosureReason;
  readonly closureTarget: string | null | undefined;
}): string | null => {
  if (
    CLOSURE_REASONS_REQUIRING_TARGET.has(input.closureReason) &&
    (input.closureTarget === undefined ||
      input.closureTarget === null ||
      input.closureTarget.trim() === "")
  ) {
    return `closureTarget is required for closure reason ${input.closureReason}.`;
  }
  return null;
};
