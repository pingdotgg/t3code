import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  EventId,
  TurnItemId,
  RuntimeRequestId,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
} from "./orchestrationCache.ts";
import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
  v2ThreadId,
} from "../state/orchestrationV2TestFixtures.ts";

import { applyOrchestrationV2ProjectionEvent } from "../state/orchestrationV2Projection.ts";

const environmentId = EnvironmentId.make("environment-cache-test");
const StoredShellSnapshotJson = Schema.fromJsonString(StoredOrchestrationShellSnapshot);
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
const encodeStoredShellSnapshot = Schema.encodeSync(StoredOrchestrationShellSnapshot);
const decodeStoredShellSnapshotSync = Schema.decodeUnknownSync(StoredOrchestrationShellSnapshot);
const encodeStoredShellSnapshotJson = Schema.encodeSync(StoredShellSnapshotJson);
const decodeStoredShellSnapshotJson = Schema.decodeUnknownSync(StoredShellSnapshotJson);
const encodeStoredThreadSnapshotJson = Schema.encodeSync(StoredThreadSnapshotJson);
const decodeStoredThreadSnapshotJson = Schema.decodeUnknownSync(StoredThreadSnapshotJson);

class TestCacheDecodeError extends Schema.TaggedErrorClass<TestCacheDecodeError>()(
  "TestCacheDecodeError",
  {
    message: Schema.String,
  },
) {}

const shellSnapshotWithSummaries: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  threads: [
    {
      ...v2ThreadShell,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("runtime-request-v2"),
        kind: "command",
        createdAt: v2Now,
      },
      latestVisibleMessage: {
        id: MessageId.make("message-v2"),
        role: "assistant",
        text: "Done",
        updatedAt: v2Now,
      },
      latestUserMessageAt: v2Now,
      settledAt: v2Now,
      titleRegeneration: {
        requestId: CommandId.make("title-regeneration-v2"),
        startedAt: v2Now,
      },
    },
  ],
};

describe("orchestration cache envelopes", () => {
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
      schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
      environmentId,
      threadId: v2ThreadId,
      snapshot: { snapshotSequence: 5, projection },
    });
    const decoded = decodeStoredThreadSnapshotJson(encoded).snapshot.projection;
    expect(decoded.turnItems.find((entry) => entry.id === item.id)).toEqual(item);
    expect(decoded.visibleTurnItems.find((entry) => entry.item.id === item.id)?.item).toEqual(item);
  });

  it.effect("round-trips V2 shell and thread cache envelopes as JSON", () =>
    Effect.sync(() => {
      const encodedShell = encodeStoredShellSnapshotJson({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot: shellSnapshotWithSummaries,
      });
      const shell = decodeStoredShellSnapshotJson(encodedShell);
      const encodedThread = encodeStoredThreadSnapshotJson({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        threadId: v2ThreadId,
        snapshot: { snapshotSequence: 4, projection: v2Projection },
      });
      const thread = decodeStoredThreadSnapshotJson(encodedThread);
      const [threadShell] = shell.snapshot.threads;

      expect(threadShell?.latestVisibleMessage?.text).toBe("Done");
      expect(
        threadShell?.latestVisibleMessage === null ||
          threadShell?.latestVisibleMessage === undefined
          ? null
          : DateTime.formatIso(threadShell.latestVisibleMessage.updatedAt),
      ).toBe("2026-06-20T00:00:00.000Z");
      expect(
        threadShell?.latestUserMessageAt === null || threadShell?.latestUserMessageAt === undefined
          ? null
          : DateTime.formatIso(threadShell.latestUserMessageAt),
      ).toBe("2026-06-20T00:00:00.000Z");
      expect(
        threadShell?.settledAt === null || threadShell?.settledAt === undefined
          ? null
          : DateTime.formatIso(threadShell.settledAt),
      ).toBe("2026-06-20T00:00:00.000Z");
      expect(
        threadShell?.titleRegeneration === null || threadShell?.titleRegeneration === undefined
          ? null
          : DateTime.formatIso(threadShell.titleRegeneration.startedAt),
      ).toBe("2026-06-20T00:00:00.000Z");
      expect(DateTime.formatIso(thread.snapshot.projection.thread.updatedAt)).toBe(
        "2026-06-20T00:00:00.000Z",
      );
      expect(thread.snapshot.projection).toEqual(v2Projection);
      expect(thread.snapshot.snapshotSequence).toBe(4);
    }),
  );

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
      }).pipe(Effect.map(Option.some));

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
