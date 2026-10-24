import {
  omitLocalVisibleTurnItems,
  restoreLocalVisibleTurnItems,
} from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { StoredOrchestrationThreadSnapshot } from "./orchestrationCache.ts";

// Keep V4 for web/desktop and existing mobile caches; older clients discard V5.
export const COMPACT_THREAD_CACHE_SCHEMA_VERSION = 5 as const;

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

class InvalidThreadCache extends Data.TaggedError("InvalidThreadCache") {}

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
  if (stored.schemaVersion !== COMPACT_THREAD_CACHE_SCHEMA_VERSION) return stored;
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
  const restored = turnItemsOmitLocalVisible
    ? restoreLocalVisibleTurnItems(projection)
    : projection;
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
  return { ...stored, snapshot: { ...snapshot, projection: restored } };
});
