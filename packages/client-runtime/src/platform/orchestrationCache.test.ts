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
const encodeStoredShellSnapshot = Schema.encodeEffect(StoredOrchestrationShellSnapshot);
const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredOrchestrationShellSnapshot);
const encodeStoredShellSnapshotJson = Schema.encodeEffect(StoredShellSnapshotJson);
const decodeStoredShellSnapshotJson = Schema.decodeUnknownEffect(StoredShellSnapshotJson);
const encodeStoredThreadSnapshotJson = Schema.encodeEffect(StoredThreadSnapshotJson);
const decodeStoredThreadSnapshotJson = Schema.decodeUnknownEffect(StoredThreadSnapshotJson);

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
    Effect.gen(function* () {
      const encodedShell = yield* encodeStoredShellSnapshotJson({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot: shellSnapshotWithSummaries,
      });
      const shell = yield* decodeStoredShellSnapshotJson(encodedShell);
      const encodedThread = yield* encodeStoredThreadSnapshotJson({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        threadId: v2ThreadId,
        thread: v2Projection,
      });
      const thread = yield* decodeStoredThreadSnapshotJson(encodedThread);
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
      expect(DateTime.formatIso(thread.thread.updatedAt)).toBe("2026-06-20T00:00:00.000Z");
    }),
  );

  it.effect("discards V1-versioned cache envelopes after a decode failure", () =>
    Effect.gen(function* () {
      let discardCount = 0;
      const encodedShell = yield* encodeStoredShellSnapshot({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot: v2ShellSnapshot,
      });
      const decoded = decodeStoredShellSnapshot({
        ...encodedShell,
        schemaVersion: 1,
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
