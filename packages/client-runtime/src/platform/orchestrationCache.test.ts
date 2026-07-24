import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
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
    },
  ],
};

describe("orchestration cache envelopes", () => {
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
