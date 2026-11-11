import * as Schema from "effect/Schema";

import { IsoDateTime, ObservationItemId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Append-only intake on a thread: observations nobody must own yet.
 * Inspired by OpenRig's `rig stream`: seats subscribe and act (link work / decline / duplicate)
 * without putting noise on the owned-obligation board.
 */
export const ObservationItemStatus = Schema.Literals(["open", "linked", "declined", "duplicated"]);
export type ObservationItemStatus = typeof ObservationItemStatus.Type;

export const OPEN_OBSERVATION_STATUSES: ReadonlySet<ObservationItemStatus> = new Set(["open"]);

export const ObservationItem = Schema.Struct({
  id: ObservationItemId,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  status: ObservationItemStatus,
  createdByThreadId: ThreadId,
  /** Set when a seat links this observation to work on another thread. */
  linkedThreadId: Schema.NullOr(ThreadId),
  /** Set when a seat marks this observation as a duplicate of another. */
  duplicateOfObservationId: Schema.NullOr(ObservationItemId),
  actedByThreadId: Schema.NullOr(ThreadId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  actedAt: Schema.NullOr(IsoDateTime),
});
export type ObservationItem = typeof ObservationItem.Type;

export const openObservationCount = (
  items: ReadonlyArray<ObservationItem> | null | undefined,
): number => items?.filter((item) => OPEN_OBSERVATION_STATUSES.has(item.status)).length ?? 0;
