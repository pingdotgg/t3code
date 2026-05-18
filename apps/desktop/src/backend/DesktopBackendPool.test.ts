import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import type { DesktopBackendSnapshot, DesktopBackendStartConfig } from "./DesktopBackendManager.ts";

function makeStubInstance(
  id: DesktopBackendPool.BackendInstanceId,
  label: string,
): DesktopBackendPool.DesktopBackendInstance {
  const snapshot: DesktopBackendSnapshot = {
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  };
  return {
    id,
    label,
    start: Effect.void,
    stop: () => Effect.void,
    currentConfig: Effect.succeed(Option.none<DesktopBackendStartConfig>()),
    snapshot: Effect.succeed(snapshot),
    waitForReady: (_timeout: Duration.Duration) => Effect.succeed(false),
  };
}

describe("DesktopBackendPool", () => {
  it.effect("layerTest exposes registered instances by id", () =>
    Effect.gen(function* () {
      const pool = yield* DesktopBackendPool.DesktopBackendPool;
      const fetchedPrimary = yield* pool.get(DesktopBackendPool.PRIMARY_INSTANCE_ID);
      const fetchedWsl = yield* pool.get(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"));
      const fetchedMissing = yield* pool.get(DesktopBackendPool.BackendInstanceId("missing"));
      const all = yield* pool.list;
      const resolvedPrimary = yield* pool.primary;

      assert.equal(Option.getOrNull(fetchedPrimary)?.label, "Windows");
      assert.equal(Option.getOrNull(fetchedWsl)?.label, "WSL (Ubuntu)");
      assert.isTrue(Option.isNone(fetchedMissing));
      assert.lengthOf(all, 2);
      // First instance becomes primary in layerTest so single-instance
      // stubs don't have to wire an explicit primary.
      assert.equal(resolvedPrimary.id, DesktopBackendPool.PRIMARY_INSTANCE_ID);
    }).pipe(
      Effect.provide(
        DesktopBackendPool.layerTest([
          makeStubInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, "Windows"),
          makeStubInstance(DesktopBackendPool.BackendInstanceId("wsl:ubuntu"), "WSL (Ubuntu)"),
        ]),
      ),
    ),
  );

  it.effect("layerTest dies when no instances are supplied", () =>
    Effect.exit(
      Effect.gen(function* () {
        yield* DesktopBackendPool.DesktopBackendPool;
      }).pipe(Effect.provide(DesktopBackendPool.layerTest([]))),
    ).pipe(Effect.map((exit) => assert.equal(exit._tag, "Failure"))),
  );
});
