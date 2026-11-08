import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates under a managed policy", () => {
  const message = "Example Corp manages T3 Code updates.";
  const managed = (
    policy: Partial<DesktopUpdatePolicy.UpdatePolicy>,
  ): DesktopUpdatePolicy.UpdatePolicy => ({
    ...DesktopUpdatePolicy.unmanagedUpdatePolicy,
    message,
    ...policy,
  });

  it.effect("never checks when updates are off", () => {
    const harness = makeHarness({ policy: managed({ mode: "off" }) });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust("10 minutes");

        const state = yield* updates.getState;
        assert.equal(state.status, "disabled");
        assert.equal(state.message, message);
        assert.isFalse((yield* updates.check("menu")).checked);
        assert.deepEqual(yield* updates.disabledReason, Option.some(message));
        assert.equal(harness.checkCount(), 0);
        assert.equal(harness.listenerCount(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates from the administrator's feed", () => {
    const harness = makeHarness({
      // Any user can set the mock flag; it must not redirect a managed feed.
      env: { T3CODE_DESKTOP_MOCK_UPDATES: "true" },
      policy: managed({ feedUrl: "https://updates.example.com/t3code" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).status, "idle");
        assert.deepEqual(harness.feedUrls(), [
          { provider: "generic", url: "https://updates.example.com/t3code" },
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("refuses the nightly channel without nightly", () => {
    const harness = makeHarness({ policy: managed({ allowNightly: false }) });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const error = yield* updates.setChannel("nightly").pipe(Effect.flip);
        assert.equal(error._tag, "DesktopUpdateChannelManagedError");
        assert.equal((yield* updates.getState).channel, "latest");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not report the channel as the only block when updates are off anyway", () => {
    const harness = makeHarness({
      appVersion: "1.2.3-nightly.20261028.1",
      env: { T3CODE_DISABLE_AUTO_UPDATE: "true" },
      policy: managed({ allowNightly: false, feedUrl: "https://updates.example.com/t3code" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const state = yield* updates.getState;
        assert.isFalse(state.enabled);
        assert.isUndefined(state.channelBlockedByPolicy);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("holds a nightly install until its user switches to stable", () => {
    const harness = makeHarness({
      appVersion: "1.2.3-nightly.20261028.1",
      // A managed app ignores the mock feed, so give it a real one.
      policy: managed({ allowNightly: false, feedUrl: "https://updates.example.com/t3code" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* TestClock.adjust("10 minutes");

        const held = yield* updates.getState;
        assert.equal(held.channel, "nightly");
        assert.equal(held.status, "disabled");
        assert.include(held.message ?? "", message);
        assert.isTrue(held.channelBlockedByPolicy);
        assert.isFalse((yield* updates.check("menu")).checked);
        assert.equal(harness.checkCount(), 0);

        const stable = yield* updates.setChannel("latest");
        assert.equal(stable.channel, "latest");
        assert.isTrue(stable.enabled);
        assert.isUndefined(stable.channelBlockedByPolicy);
        assert.equal(harness.checkCount(), 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
