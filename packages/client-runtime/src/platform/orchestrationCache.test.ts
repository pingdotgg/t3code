import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
} from "./orchestrationCache.ts";
import { v2Projection, v2ShellSnapshot, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-cache-test");
const decodeStoredShellSnapshot = Schema.decodeUnknownEffect(StoredOrchestrationShellSnapshot);
const decodeStoredThreadSnapshot = Schema.decodeUnknownEffect(StoredOrchestrationThreadSnapshot);

describe("orchestration cache envelopes", () => {
  it.effect("accepts V2 shell and thread cache envelopes", () =>
    Effect.gen(function* () {
      const shell = yield* decodeStoredShellSnapshot({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot: v2ShellSnapshot,
      });
      const thread = yield* decodeStoredThreadSnapshot({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        threadId: v2ThreadId,
        thread: v2Projection,
      });

      expect(shell.snapshot).toEqual(v2ShellSnapshot);
      expect(thread.thread).toEqual(v2Projection);
    }),
  );

  it.effect("discards V1-versioned cache envelopes after a decode failure", () =>
    Effect.gen(function* () {
      let discardCount = 0;
      const decoded = decodeStoredShellSnapshot({
        schemaVersion: 1,
        environmentId,
        snapshot: v2ShellSnapshot,
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
