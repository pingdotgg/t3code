import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, EventId, TurnItemId, knownThreadProjection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
} from "./orchestrationCache.ts";
import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadId,
} from "../state/orchestrationV2TestFixtures.ts";

import { decodeStoredThreadSnapshot, encodeStoredThreadSnapshot } from "./threadCacheEncoding.ts";

import { applyOrchestrationV2ProjectionEvent } from "../state/orchestrationV2Projection.ts";

const environmentId = EnvironmentId.make("environment-cache-test");
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
const encodeStoredShellSnapshot = Schema.encodeSync(StoredOrchestrationShellSnapshot);
const decodeStoredShellSnapshotSync = Schema.decodeUnknownSync(StoredOrchestrationShellSnapshot);
const encodeStoredThreadSnapshotJson = Schema.encodeSync(StoredThreadSnapshotJson);
const decodeStoredThreadSnapshotJson = Schema.decodeUnknownSync(StoredThreadSnapshotJson);

class TestCacheDecodeError extends Schema.TaggedError<TestCacheDecodeError>()(
  "TestCacheDecodeError",
  {
    message: Schema.String,
  },
) {}

describe("orchestration cache envelopes", () => {
  it.effect("discards compact caches with unknown items without weakening count checks", () =>
    Effect.gen(function* () {
      const stored = {
        environmentId,
        threadId: v2ThreadId,
        snapshot: { snapshotSequence: 4, projection: v2Projection },
      };
      const encoded = yield* encodeStoredThreadSnapshot(stored);
      expect((yield* decodeStoredThreadSnapshot(encoded)).snapshot.projection).toEqual(
        v2Projection,
      );
      const wire = JSON.parse(encoded);
      wire.snapshot.projection.turnItems = [{ type: "future_item" }];
      wire.snapshot.turnItemCount = 1;
      const unknown = yield* Effect.flip(decodeStoredThreadSnapshot(JSON.stringify(wire)));
      expect(unknown._tag).toBe("InvalidThreadCache");
      wire.snapshot.projection.turnItems = [];
      const truncated = yield* Effect.flip(decodeStoredThreadSnapshot(JSON.stringify(wire)));
      expect(truncated._tag).toBe("InvalidThreadCache");
    }),
  );

  it("preserves live provider notices through persisted thread snapshots", () => {
    const item = {
      id: TurnItemId.make("notice-cache"),
      threadId: v2ThreadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "system_notice" as const,
      message: "Safeguards flagged this message. Switched to Opus 4.8.",
    };
    const projection = applyOrchestrationV2ProjectionEvent(v2Projection, {
      id: EventId.make("notice-cache-event"),
      type: "turn-item.updated",
      threadId: v2ThreadId,
      occurredAt: v2Now,
      payload: item,
    });
    expect(projection).not.toBeNull();
    if (projection === null) throw new Error("Expected live notice projection");
    const encoded = encodeStoredThreadSnapshotJson({
      schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
      environmentId,
      threadId: v2ThreadId,
      snapshot: { snapshotSequence: 5, projection },
    });
    const decoded = knownThreadProjection(
      decodeStoredThreadSnapshotJson(encoded).snapshot.projection,
    );
    expect(decoded.turnItems.find((entry) => entry.id === item.id)).toEqual(item);
    expect(decoded.visibleTurnItems.find((entry) => entry.item.id === item.id)?.item).toEqual(item);
  });

  it("rejects thread snapshots saved before human history was bounded, but not shells", () => {
    const currentThread = encodeStoredThreadSnapshotJson({
      schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
      environmentId,
      threadId: v2ThreadId,
      snapshot: { snapshotSequence: 4, projection: v2Projection },
    });
    for (const staleVersion of [3, 4]) {
      const staleThread = currentThread.replace(
        `"schemaVersion":${ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION}`,
        `"schemaVersion":${staleVersion}`,
      );
      expect(() => decodeStoredThreadSnapshotJson(staleThread)).toThrow();
    }
    const shell = encodeStoredShellSnapshot({
      schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
      environmentId,
      snapshot: v2ShellSnapshot,
    });
    expect(decodeStoredShellSnapshotSync(shell).schemaVersion).toBe(3);
  });

  it.effect("discards V1-versioned cache envelopes after a decode failure", () =>
    Effect.gen(function* () {
      let discardCount = 0;
      const encodedShell = encodeStoredShellSnapshot({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot: v2ShellSnapshot,
      });
      const decoded = Effect.try({
        try: () => decodeStoredShellSnapshotSync({ ...encodedShell, schemaVersion: 1 }),
        catch: (cause) => new TestCacheDecodeError({ message: String(cause) }),
      }).pipe(Effect.asSome);

      const result = yield* decodeOrDiscardOrchestrationCache(
        decoded,
        Effect.sync(() => {
          discardCount += 1;
        }),
      );

      expect(Option.isNone(result)).toBe(true);
      expect(discardCount).toBe(1);
    }),
  );
});
