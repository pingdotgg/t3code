import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DesktopBackendManager from "../backend/DesktopBackendManager.ts";
import { reconcileInstanceAfterResume } from "./DesktopPowerRecovery.ts";

function fakeInstance(input: {
  readonly desiredRunning?: boolean;
  readonly ready?: boolean;
  readonly probeReady?: boolean;
  readonly restartReady?: boolean;
}) {
  let probes = 0;
  let stops = 0;
  let starts = 0;
  let waits = 0;
  const instance: DesktopBackendManager.DesktopBackendInstance = {
    id: DesktopBackendManager.BackendInstanceId("primary"),
    label: Effect.succeed("fixture"),
    currentConfig: Effect.succeed(Option.none()),
    snapshot: Effect.succeed({
      desiredRunning: input.desiredRunning ?? true,
      ready: input.ready ?? true,
      activePid: Option.some(123),
      restartAttempt: 0,
      restartScheduled: false,
    }),
    probeReady: (_timeout: Duration.Duration) =>
      Effect.sync(() => {
        probes += 1;
        return input.probeReady ?? true;
      }),
    stop: () =>
      Effect.sync(() => {
        stops += 1;
      }),
    start: Effect.sync(() => {
      starts += 1;
    }),
    waitForReady: (_timeout: Duration.Duration) =>
      Effect.sync(() => {
        waits += 1;
        return input.restartReady ?? true;
      }),
  };
  return {
    instance,
    counts: () => ({ probes, stops, starts, waits }),
  };
}

describe("DesktopPowerRecovery", () => {
  it.effect("leaves a live backend untouched after resume", () =>
    Effect.gen(function* () {
      const fixture = fakeInstance({ probeReady: true });
      yield* reconcileInstanceAfterResume(fixture.instance);
      assert.deepStrictEqual(fixture.counts(), { probes: 1, stops: 0, starts: 0, waits: 0 });
    }),
  );

  it.effect("restarts a backend whose ready flag is stale", () =>
    Effect.gen(function* () {
      const fixture = fakeInstance({ probeReady: false, restartReady: true });
      yield* reconcileInstanceAfterResume(fixture.instance);
      assert.deepStrictEqual(fixture.counts(), { probes: 1, stops: 1, starts: 1, waits: 1 });
    }),
  );

  it.effect("restarts a desired backend that was already not ready", () =>
    Effect.gen(function* () {
      const fixture = fakeInstance({ ready: false, restartReady: true });
      yield* reconcileInstanceAfterResume(fixture.instance);
      assert.deepStrictEqual(fixture.counts(), { probes: 0, stops: 1, starts: 1, waits: 1 });
    }),
  );

  it.effect("does not resurrect a backend the user stopped", () =>
    Effect.gen(function* () {
      const fixture = fakeInstance({ desiredRunning: false, ready: false });
      yield* reconcileInstanceAfterResume(fixture.instance);
      assert.deepStrictEqual(fixture.counts(), { probes: 0, stops: 0, starts: 0, waits: 0 });
    }),
  );
});
