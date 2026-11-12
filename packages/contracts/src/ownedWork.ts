import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, OwnedWorkItemId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Home-thread owned work (OpenRig queue-inspired). `assigneeThreadId` is the destination seat;
 * assignees act through `listOwnedWorkInbox` against the home id. Closure records delivery only.
 */
export const OwnedWorkItemStatus = Schema.Literals([
  "assigned",
  "claimed",
  "in_progress",
  "on_hold",
  "needs_attention",
  "handed_off",
  "completed",
  "cancelled",
]);
export type OwnedWorkItemStatus = typeof OwnedWorkItemStatus.Type;

export const OPEN_OWNED_WORK_STATUSES: ReadonlySet<OwnedWorkItemStatus> = new Set([
  "assigned",
  "claimed",
  "in_progress",
  "on_hold",
  "needs_attention",
  "handed_off",
]);

/**
 * Delivery outcome when work closes. Human UX maps Done / Cancel / Handoff onto these;
 * agents may also record denied / escalation / superseded.
 */
export const OwnedWorkClosureReason = Schema.Literals([
  "done",
  "canceled",
  "handed_off",
  "denied",
  "escalation",
  "superseded",
  "no_follow_on",
]);
export type OwnedWorkClosureReason = typeof OwnedWorkClosureReason.Type;

/** Labels shown in Done / Cancel / Handoff controls (not raw admin codes). */
export const OWNED_WORK_CLOSURE_UX = {
  done: { reason: "done" as const, label: "Done" },
  cancel: { reason: "canceled" as const, label: "Cancel" },
  handoff: { reason: "handed_off" as const, label: "Handoff" },
} as const;

const CLOSURE_REASONS_REQUIRING_TARGET: ReadonlySet<OwnedWorkClosureReason> = new Set([
  "handed_off",
  "escalation",
]);

export const OwnedWorkHistoryKind = Schema.Literals([
  "assigned",
  "claimed",
  "progress",
  "hold",
  "resume",
  "attention",
  "handoff",
  "completed",
  "cancelled",
]);
export type OwnedWorkHistoryKind = typeof OwnedWorkHistoryKind.Type;

export const OwnedWorkHistoryEntry = Schema.Struct({
  at: IsoDateTime,
  kind: OwnedWorkHistoryKind,
  actorThreadId: Schema.NullOr(ThreadId),
  note: Schema.NullOr(Schema.String),
  closureReason: Schema.optional(Schema.NullOr(OwnedWorkClosureReason)),
  toThreadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type OwnedWorkHistoryEntry = typeof OwnedWorkHistoryEntry.Type;

/** Cap so closed threads keep a readable trail without unbounded growth. */
const OWNED_WORK_HISTORY_LIMIT = 40;

export const OwnedWorkItem = Schema.Struct({
  id: OwnedWorkItemId,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  status: OwnedWorkItemStatus,
  /** Who should pick this up; null means any teammate on the home thread may claim. */
  assigneeThreadId: Schema.NullOr(ThreadId),
  claimedByThreadId: Schema.NullOr(ThreadId),
  progress: Schema.NullOr(Schema.String),
  /** Why work is parked; cleared on resume. */
  holdReason: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Why the item needs a human/agent wake; cleared when work resumes. */
  attentionReason: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Last live reassignment note. */
  handoffNote: Schema.NullOr(Schema.String),
  /** Set when the item is completed or cancelled. */
  closureReason: Schema.optional(Schema.NullOr(OwnedWorkClosureReason)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Destination for `handed_off` / `escalation` closures. */
  closureTarget: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  closureNote: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  history: Schema.optional(Schema.Array(OwnedWorkHistoryEntry)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
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

/** Whether an open item should appear in `actorThreadId`'s cross-seat inbox. */
export const ownedWorkInboxRelevant = (item: OwnedWorkItem, actorThreadId: ThreadId): boolean => {
  if (!OPEN_OWNED_WORK_STATUSES.has(item.status)) return false;
  if (item.claimedByThreadId === actorThreadId) return true;
  return (
    (item.status === "assigned" || item.status === "handed_off") &&
    item.assigneeThreadId === actorThreadId
  );
};

export const appendOwnedWorkHistory = (
  history: ReadonlyArray<OwnedWorkHistoryEntry> | null | undefined,
  entry: OwnedWorkHistoryEntry,
): ReadonlyArray<OwnedWorkHistoryEntry> =>
  [...(history ?? []), entry].slice(-OWNED_WORK_HISTORY_LIMIT);

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
    return `A handoff target is required for ${input.closureReason}.`;
  }
  return null;
};
