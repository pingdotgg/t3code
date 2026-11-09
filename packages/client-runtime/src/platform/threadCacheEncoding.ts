import { OrchestrationV2ThreadProjectionJson } from "@t3tools/contracts";
import {
  omitLocalVisibleTurnItems,
  restoreLocalVisibleTurnItems,
} from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { yieldToHostTimer } from "./hostYield.ts";
import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
} from "./orchestrationCache.ts";

// Keep the full format for web/desktop; older clients discard compact records.
export const COMPACT_THREAD_CACHE_SCHEMA_VERSION = 6 as const;

/**
 * A thread followed live keeps every item it streams, so its projection can grow
 * to hundreds of MB. Larger ones are not cached; reopening loads the bounded window.
 */
const THREAD_CACHE_MAX_JSON_LENGTH = 4 * 1024 * 1024;

const ROWS_PER_CHUNK = 32;

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

const decodeCompatible = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([StoredCompactThreadSnapshot, StoredOrchestrationThreadSnapshot]),
  ),
);

const EncodedRows = Schema.Array(Schema.Unknown);
const ProjectionWithEncodedRows = OrchestrationV2ThreadProjectionJson.mapFields((fields) => ({
  ...fields,
  turnItems: EncodedRows,
  visibleTurnItems: EncodedRows,
}));
const encodeFullEnvelope = Schema.encodeEffect(
  Schema.fromJsonString(
    StoredOrchestrationThreadSnapshot.mapFields((fields) => ({
      ...fields,
      snapshot: fields.snapshot.mapFields((snapshotFields) => ({
        ...snapshotFields,
        projection: ProjectionWithEncodedRows,
      })),
    })),
  ),
);
const encodeCompactEnvelope = Schema.encodeEffect(
  Schema.fromJsonString(
    StoredCompactThreadSnapshot.mapFields((fields) => ({
      ...fields,
      snapshot: fields.snapshot.mapFields((snapshotFields) => ({
        ...snapshotFields,
        projection: ProjectionWithEncodedRows,
      })),
    })),
  ),
);
const encodeTurnItemChunk = Schema.encodeEffect(
  OrchestrationV2ThreadProjectionJson.fields.turnItems,
);
const encodeVisibleRowChunk = Schema.encodeEffect(
  OrchestrationV2ThreadProjectionJson.fields.visibleTurnItems,
);

type StoredThread = Pick<
  typeof StoredOrchestrationThreadSnapshot.Type,
  "environmentId" | "threadId" | "snapshot"
>;
type Projection = StoredThread["snapshot"]["projection"];

interface EncodedRow {
  readonly encoded: unknown;
  readonly length: number;
}

/**
 * Turn items are immutable and the projection reducer keeps unchanged ones by
 * reference, so each encoder remembers the encoding of rows it has encoded and
 * runs the row codec only for new ones, yielding to the host between chunks.
 * Encodes to none once the rows exceed `maxJsonLength`, before the envelope.
 */
export function makeStoredThreadSnapshotEncoder(options: {
  readonly format: "full" | "compact";
  readonly yieldToHost?: Effect.Effect<void>;
  readonly maxJsonLength?: number;
}) {
  const yieldToHost = options.yieldToHost ?? yieldToHostTimer;
  const maxJsonLength = options.maxJsonLength ?? THREAD_CACHE_MAX_JSON_LENGTH;
  const encodedTurnItems = new WeakMap<object, EncodedRow>();
  const encodedVisibleRows = new WeakMap<object, EncodedRow>();

  return Effect.fnUntraced(function* (stored: StoredThread) {
    let hasWorked = false;
    let length = 0;
    const encodeRows =
      /* Runs once per thread save inside the traced store call; avoid a span per row list. */
      Effect.fnUntraced(function* <Row extends object>(
        rows: ReadonlyArray<Row>,
        cache: WeakMap<object, EncodedRow>,
        encodeChunk: (
          chunk: ReadonlyArray<Row>,
        ) => Effect.Effect<ReadonlyArray<unknown>, Schema.SchemaError>,
      ) {
        let misses: Array<Row> = [];
        const encodeMisses = Effect.gen(function* () {
          if (hasWorked) yield* yieldToHost;
          hasWorked = true;
          const chunk = yield* encodeChunk(misses);
          chunk.forEach((encoded, index) => {
            const row = { encoded, length: JSON.stringify(encoded).length };
            cache.set(misses[index]!, row);
            length += row.length;
          });
          misses = [];
        });
        for (const row of rows) {
          const cached = cache.get(row);
          if (cached === undefined) misses.push(row);
          else length += cached.length;
          if (misses.length === ROWS_PER_CHUNK) yield* encodeMisses;
          if (length > maxJsonLength) return undefined;
        }
        if (misses.length > 0) yield* encodeMisses;
        if (length > maxJsonLength) return undefined;
        return rows.map((row) => cache.get(row)!.encoded);
      });
    const encodeProjectionRows =
      /* Runs once per thread save inside the traced store call. */
      Effect.fnUntraced(function* (projection: Projection) {
        const turnItems = yield* encodeRows(
          projection.turnItems,
          encodedTurnItems,
          encodeTurnItemChunk,
        );
        if (turnItems === undefined) return undefined;
        const visibleTurnItems = yield* encodeRows(
          projection.visibleTurnItems,
          encodedVisibleRows,
          encodeVisibleRowChunk,
        );
        if (visibleTurnItems === undefined) return undefined;
        if (hasWorked) yield* yieldToHost;
        return { ...projection, turnItems, visibleTurnItems };
      });

    const { snapshot } = stored;
    let payload: string;
    if (options.format === "full") {
      const projection = yield* encodeProjectionRows(snapshot.projection);
      if (projection === undefined) return Option.none<string>();
      payload = yield* encodeFullEnvelope({
        ...stored,
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        snapshot: { ...snapshot, projection },
      });
    } else {
      const compact = omitLocalVisibleTurnItems(snapshot.projection);
      const projection = yield* encodeProjectionRows(compact ?? snapshot.projection);
      if (projection === undefined) return Option.none<string>();
      payload = yield* encodeCompactEnvelope({
        ...stored,
        schemaVersion: COMPACT_THREAD_CACHE_SCHEMA_VERSION,
        snapshot: {
          ...snapshot,
          projection,
          turnItemsOmitLocalVisible: compact !== null,
          turnItemCount: snapshot.projection.turnItems.length,
          visibleTurnItemCount: snapshot.projection.visibleTurnItems.length,
        },
      });
    }
    // The rest of the projection is not budgeted row by row; a huge one still stays out.
    return payload.length > maxJsonLength ? Option.none<string>() : Option.some(payload);
  });
}

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
