import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
} from "./orchestrationCache.ts";
import {
  decodeStoredThreadSnapshot,
  makeStoredThreadSnapshotEncoder,
} from "./threadCacheEncoding.ts";

const environmentId = EnvironmentId.make("environment-thread-cache");
const otherThreadId = ThreadId.make("thread-parent");
const encodeOriginal = Schema.encodeEffect(
  Schema.fromJsonString(StoredOrchestrationThreadSnapshot),
);

const notice = (index: number, threadId = v2ThreadId) => ({
  id: TurnItemId.make(`notice-${threadId}-${index}`),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: index,
  status: "completed" as const,
  title: index % 2 === 0 ? null : `  Notice ${index}  `,
  startedAt: DateTime.add(v2Now, { seconds: index }),
  completedAt: index % 3 === 0 ? null : v2Now,
  updatedAt: v2Now,
  type: "system_notice" as const,
  message: `Notice ${index}`,
});

// Inherited rows come first, as in a fork, then local rows whose items alias turnItems.
function projectionWith(count: number): OrchestrationV2ThreadProjection {
  const inherited = Array.from({ length: 5 }, (_, index) => notice(index, otherThreadId));
  const turnItems = Array.from({ length: count }, (_, index) => notice(index));
  return {
    ...v2Projection,
    turnItems,
    visibleTurnItems: [
      ...inherited.map((item) => ({
        position: 0,
        visibility: "inherited" as const,
        sourceThreadId: otherThreadId,
        sourceItemId: item.id,
        item,
      })),
      ...turnItems.map((item) => ({
        position: 0,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
        item,
      })),
    ].map((row, position) => ({ ...row, position })),
  };
}

const stored = (projection: OrchestrationV2ThreadProjection) => ({
  environmentId,
  threadId: v2ThreadId,
  snapshot: { snapshotSequence: 7, projection, historyCursor: null, hasMoreHistory: false },
});

describe("cooperative thread cache encoding", () => {
  it.effect("matches the plain encoding across chunks, cold and after rows change", () =>
    Effect.gen(function* () {
      const encode = makeStoredThreadSnapshotEncoder({ format: "full" });
      const original = (projection: OrchestrationV2ThreadProjection) =>
        encodeOriginal({
          ...stored(projection),
          schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        });
      const cold = projectionWith(70);
      expect(yield* encode(stored(cold))).toEqual(Option.some(yield* original(cold)));

      const [first, ...rest] = cold.turnItems;
      const replaced = { ...first!, message: "Edited" };
      const added = notice(70);
      const warm: OrchestrationV2ThreadProjection = {
        ...cold,
        turnItems: [replaced, ...rest, added],
        visibleTurnItems: [
          ...cold.visibleTurnItems.map((row) =>
            row.item === first ? { ...row, item: replaced } : row,
          ),
          {
            position: cold.visibleTurnItems.length,
            visibility: "local",
            sourceThreadId: v2ThreadId,
            sourceItemId: added.id,
            item: added,
          },
        ],
      };
      expect(yield* encode(stored(warm))).toEqual(Option.some(yield* original(warm)));
    }),
  );

  it.effect("round-trips the compact format", () =>
    Effect.gen(function* () {
      const projection = projectionWith(40);
      const encoded = yield* makeStoredThreadSnapshotEncoder({ format: "compact" })(
        stored(projection),
      );
      const decoded = yield* decodeStoredThreadSnapshot(Option.getOrThrow(encoded));
      expect(decoded.snapshot.projection).toEqual(projection);
    }),
  );

  it.effect("encodes nothing once the rows exceed the budget, warm or cold", () =>
    Effect.gen(function* () {
      const small = stored(projectionWith(4));
      const large = stored(projectionWith(200));
      const limit = Option.getOrThrow(
        yield* makeStoredThreadSnapshotEncoder({ format: "full" })(small),
      ).length;
      for (const format of ["full", "compact"] as const) {
        const encode = makeStoredThreadSnapshotEncoder({ format, maxJsonLength: limit });
        expect(Option.isSome(yield* encode(small))).toBe(true);
        expect(Option.isNone(yield* encode(large))).toBe(true);
        expect(Option.isNone(yield* encode(large))).toBe(true);
      }
    }),
  );
});
