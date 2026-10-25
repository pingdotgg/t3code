import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";

import { omitLocalVisibleTurnItems } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import { dedupeSnapshotBodies } from "@t3tools/shared/orchestrationV2DedupedBodies";

import {
  buildBoundedThreadProjection,
  type BoundedProjectionResult,
} from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

export const THREAD_RESUME_MAX_REPLAY_EVENTS = 128;

export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;

/** Decoded objects and temporary strings exceed stored JSON size, even before wire slimming. */
export const THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES = 1_048_576;

export function isThreadReplayRawPayloadSafe(rawPayloadBytes: number): boolean {
  return rawPayloadBytes <= THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES;
}

export function threadReplayEncodedBytes(items: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const item of items) {
    const encoded = JSON.stringify(item);
    total += Buffer.byteLength(encoded ?? "", "utf8");
  }
  return total;
}

type ThreadSnapshotStreamItem = Extract<
  OrchestrationV2ThreadStreamItem,
  { readonly kind: "snapshot" }
>;

export function boundedSnapshotResponseFields(input: {
  readonly bounded: BoundedProjectionResult;
  readonly compactTurnItems: boolean;
  readonly dedupeBodies: boolean;
}) {
  const { bounded } = input;
  // Dedupe keeps shared items one object, which the compaction's identity check needs.
  const projection = input.dedupeBodies
    ? dedupeSnapshotBodies(bounded.projection)
    : bounded.projection;
  const compactProjection = input.compactTurnItems ? omitLocalVisibleTurnItems(projection) : null;
  return {
    projection: compactProjection ?? projection,
    historyCursor: bounded.historyCursor,
    hasMoreHistory: bounded.hasMoreHistory,
    latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
    ...(compactProjection === null ? {} : { turnItemsOmitLocalVisible: true as const }),
  };
}

export function buildBoundedThreadStreamSnapshot(input: {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly compactTurnItems?: boolean;
  readonly dedupeBodies?: boolean;
}): ThreadSnapshotStreamItem {
  const bounded = buildBoundedThreadProjection({
    snapshotSequence: input.snapshotSequence,
    projection: projectThreadProjectionForWire(input.projection),
  });
  return {
    kind: "snapshot",
    snapshotSequence: input.snapshotSequence,
    ...boundedSnapshotResponseFields({
      bounded,
      compactTurnItems: input.compactTurnItems === true,
      dedupeBodies: input.dedupeBodies === true,
    }),
  };
}

export type ThreadResumePlan =
  | {
      readonly mode: "replay";
      readonly afterSequence: number;
      readonly throughSequence: number;
    }
  | { readonly mode: "snapshot" };

/** Bound event count and encoded bytes; replace excessive replay with one current snapshot. */
export function decideThreadResume(input: {
  readonly afterSequence: number;
  readonly highWater: number;
  readonly replayEventCount: number;
  readonly replayEncodedBytes: number;
}): ThreadResumePlan {
  if (
    input.afterSequence > input.highWater ||
    input.replayEventCount > THREAD_RESUME_MAX_REPLAY_EVENTS ||
    input.replayEncodedBytes > THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES
  ) {
    return { mode: "snapshot" };
  }
  return {
    mode: "replay",
    afterSequence: input.afterSequence,
    throughSequence: input.highWater,
  };
}
