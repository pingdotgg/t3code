import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";

import { omitLocalVisibleTurnItems } from "@t3tools/shared/orchestrationV2BoundedSnapshot";

import {
  buildBoundedThreadProjection,
  type BoundedProjectionResult,
} from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";

export const THREAD_RESUME_MAX_REPLAY_EVENTS = 128;

export const THREAD_RESUME_MAX_REPLAY_ENCODED_BYTES = 1_048_576;

/**
 * Keep the original preflight budget: decoded objects and temporary strings
 * cost more than their stored JSON, even if wire projection shrinks them later.
 */
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
}) {
  const { bounded } = input;
  const compactProjection = input.compactTurnItems
    ? omitLocalVisibleTurnItems(bounded.projection)
    : null;
  return {
    projection: compactProjection ?? bounded.projection,
    historyCursor: bounded.historyCursor,
    hasMoreHistory: bounded.hasMoreHistory,
    latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
    payloadBudgetExceeded: bounded.payloadBudgetExceeded,
    ...(compactProjection === null ? {} : { turnItemsOmitLocalVisible: true as const }),
  };
}

export function buildBoundedThreadStreamSnapshot(input: {
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly compactTurnItems?: boolean;
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

/**
 * Event count limits reducer churn while encoded bytes limit a small number of
 * large updates. Either excess is cheaper to replace with one current snapshot.
 */
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
