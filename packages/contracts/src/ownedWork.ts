import * as Schema from "effect/Schema";

import { IsoDateTime, OwnedWorkItemId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Durable owned work on a thread: assign → claim → progress → handoff.
 * Inspired by OpenRig's `rig queue`: the item stays visible after the chat moves on.
 * Lives on the home (assigning) thread projection; assignees claim by id.
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
