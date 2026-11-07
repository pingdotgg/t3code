import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import {
  omitLocalVisibleTurnItems,
  restoreLocalVisibleTurnItems,
} from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import {
  dedupeSnapshotBodies,
  restoreSnapshotBodies,
} from "@t3tools/shared/orchestrationV2DedupedBodies";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
} from "./orchestrationCache.ts";

// Each item is written once and shared again on decode, so a thread loaded from the cache costs
// what a thread from the server costs. Older clients discard these records and refetch.
export const COMPACT_THREAD_CACHE_SCHEMA_VERSION = 6 as const;

const StoredCompactThreadSnapshot = StoredOrchestrationThreadSnapshot.mapFields((fields) => ({
  ...fields,
  schemaVersion: Schema.Literal(COMPACT_THREAD_CACHE_SCHEMA_VERSION),
  snapshot: fields.snapshot.mapFields((snapshotFields) => ({
    ...snapshotFields,
    // Required metadata prevents partial compact records from masquerading as full ones.
    turnItemsOmitLocalVisible: Schema.Boolean,
    turnItemCount: Schema.Int,
    visibleTurnItemCount: Schema.Int,
  })),
}));

class InvalidThreadCache extends Schema.TaggedError<InvalidThreadCache>()(
  "InvalidThreadCache",
  {},
) {}

/** JSON decodes every copy of a body separately: point an item at its record's copy again. */
function shareBodiesWithRecords(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return restoreSnapshotBodies(dedupeSnapshotBodies(projection));
}

/** A full record decodes both copies of each item: keep one object wherever they match. */
function shareFullRecordItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const items = new Map(projection.turnItems.map((item) => [item.id, item]));
  const visibleTurnItems = projection.visibleTurnItems.map((row) => {
    const item = row.sourceThreadId === projection.thread.id ? items.get(row.item.id) : undefined;
    return item !== undefined && Equal.equals(item, row.item) ? { ...row, item } : row;
  });
  return { ...projection, visibleTurnItems };
}

const encodeCompact = Schema.encodeEffect(Schema.fromJsonString(StoredCompactThreadSnapshot));
const decodeCompatible = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([StoredCompactThreadSnapshot, StoredOrchestrationThreadSnapshot]),
  ),
);

export const encodeStoredThreadSnapshot = Effect.fn("ThreadCache.encode")(function* (
  stored: Pick<
    typeof StoredOrchestrationThreadSnapshot.Type,
    "environmentId" | "threadId" | "snapshot"
  >,
) {
  const { snapshot } = stored;
  const compact = omitLocalVisibleTurnItems(snapshot.projection);
  return yield* encodeCompact({
    ...stored,
    schemaVersion: COMPACT_THREAD_CACHE_SCHEMA_VERSION,
    snapshot: {
      ...snapshot,
      projection: compact ?? snapshot.projection,
      turnItemsOmitLocalVisible: compact !== null,
      turnItemCount: snapshot.projection.turnItems.length,
      visibleTurnItemCount: snapshot.projection.visibleTurnItems.length,
    },
  });
});

export const decodeStoredThreadSnapshot = Effect.fn("ThreadCache.decode")(function* (raw: string) {
  const stored = yield* decodeCompatible(raw);
  if (stored.schemaVersion === ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION) {
    return {
      ...stored,
      snapshot: {
        ...stored.snapshot,
        projection: shareBodiesWithRecords(shareFullRecordItems(stored.snapshot.projection)),
      },
    };
  }
  const { turnItemsOmitLocalVisible, turnItemCount, visibleTurnItemCount, ...snapshot } =
    stored.snapshot;
  const { projection } = snapshot;
  const threadId = projection.thread.id;
  let previousPosition = -1;
  const visibleIds = new Set<string>();
  const validRows = projection.visibleTurnItems.every((row) => {
    const identity = JSON.stringify([row.sourceThreadId, row.sourceItemId]);
    const valid =
      row.sourceItemId === row.item.id &&
      (row.sourceThreadId === row.item.threadId ||
        (row.item.type === "fork" &&
          row.item.source.type === "run" &&
          row.sourceThreadId === row.item.source.threadId)) &&
      (row.visibility !== "local" || row.sourceThreadId === threadId) &&
      (row.visibility !== "inherited" || row.sourceThreadId !== threadId) &&
      row.position > previousPosition &&
      !visibleIds.has(identity);
    previousPosition = row.position;
    visibleIds.add(identity);
    return valid;
  });
  // A record that could not be compacted carries both copies: a retained request card followed by
  // newer items is enough, since `turnItems` then no longer starts with the visible rows.
  const restored = turnItemsOmitLocalVisible
    ? restoreLocalVisibleTurnItems(projection)
    : shareFullRecordItems(projection);
  const itemIds = new Set<string>();
  const validItems = restored.turnItems.every((item) => {
    const valid = item.threadId === threadId && !itemIds.has(item.id);
    itemIds.add(item.id);
    return valid;
  });
  if (
    stored.threadId !== threadId ||
    restored.turnItems.length !== turnItemCount ||
    projection.visibleTurnItems.length !== visibleTurnItemCount ||
    !validRows ||
    !validItems ||
    projection.visibleTurnItems.some(
      (row) => row.sourceThreadId === threadId && !itemIds.has(row.sourceItemId),
    )
  ) {
    return yield* new InvalidThreadCache();
  }
  return { ...stored, snapshot: { ...snapshot, projection: shareBodiesWithRecords(restored) } };
});
