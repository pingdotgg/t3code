import { assert, describe, it } from "@effect/vitest";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

describe("DesktopUpdates", () => {
  it.effect("offers nothing below a track switch's checked release", () => {
    const harness = makeHarness({
      appVersion: "1.2.4-nightly.20261027.1",
      beforeSetUpdateChannel: Effect.void,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("latest", { minimumVersion: "1.2.3" });

        harness.emit("update-available", { version: "1.2.2" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).availableVersion);
        harness.emit("update-downloaded", { version: "1.2.2" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).downloadedVersion);

        harness.emit("update-available", { version: "1.2.3" });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).availableVersion, "1.2.3");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps a saved Stable track across a restart without offering an older release", () => {
    // A Nightly build whose switch to Stable did not finish before the app quit.
    const harness = makeHarness({ appVersion: "1.2.4-nightly.20261027.1", savedChannel: "latest" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("startup");

        assert.equal((yield* updates.getState).channel, "latest");
        assert.deepEqual(harness.checkAllowedDowngrade, [false]);
        // Semver ranks Stable 1.2.4 above this Nightly, but a Nightly built before the release's
        // version bump can hold migrations 1.2.4 lacks. Crossing needs a guarded switch.
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isNull((yield* updates.getState).availableVersion);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps a saved Nightly track across a restart without crossing on its own", () => {
    // A Stable build whose switch to Nightly was refused before the app quit; its floor is gone.
    const harness = makeHarness({ savedChannel: "nightly" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("startup");
        harness.emit("update-available", { version: "1.2.4-nightly.20261027.1" });
        yield* flushCallbacks;

        assert.equal((yield* updates.getState).channel, "nightly");
        assert.isNull((yield* updates.getState).availableVersion);
        assert.deepEqual(harness.checkAllowedDowngrade, [false]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("never offers an older Nightly to a Nightly build's own checks", () => {
    const harness = makeHarness({ appVersion: "1.2.4-nightly.20261027.1" });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("poll");

        assert.equal((yield* updates.getState).channel, "nightly");
        assert.deepEqual(harness.checkAllowedDowngrade, [false]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("waits out a background check instead of refusing a track change", () =>
    Effect.gen(function* () {
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Effect.void,
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          yield* updates.check("poll").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.succeed(releaseCheck, undefined);
          yield* TestClock.adjust(Duration.seconds(2));
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("rejects checks while an update channel change is being persisted", () =>
    Effect.gen(function* () {
      const channelChangeStarted = yield* Deferred.make<void>();
      const releaseChannelChange = yield* Deferred.make<void>();
      const harness = makeHarness({
        beforeSetUpdateChannel: Deferred.succeed(channelChangeStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseChannelChange)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          const channelFiber = yield* updates.setChannel("nightly").pipe(Effect.forkScoped);
          yield* Deferred.await(channelChangeStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseChannelChange, undefined);
          const state = yield* Fiber.join(channelFiber);

          assert.equal(state.channel, "nightly");
          assert.equal(harness.checkCount(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );
});

describe("describeUpdateErrorCause", () => {
  it("removes URLs, credentials, response bodies, and headers from summaries", () => {
    const messages = [
      "Cannot download https://user:url-secret@example.com/update?token=query-secret, status 403",
      "Request failed: Bearer bearer-secret",
      "Request failed: Basic basic-secret",
      "Request failed: Authorization: Bearer header-secret",
      "Request failed: Cookie=session-secret",
      "Request failed: api_key=\"key-secret\" password='password-secret' access_token=token-secret",
      '404 Not Found\n{"body":"body-secret"}\nHeaders: cookie=header-secret',
      "Request failed\rHeaders: cookie=header-secret",
    ];

    for (const message of messages) {
      const summary = DesktopUpdates.describeUpdateErrorCause(new Error(message));
      assert.include(summary, "Error:");
      assert.notInclude(summary, "secret");
      assert.notInclude(summary, "https://");
      assert.notInclude(summary, "Headers:");
    }
    assert.equal(
      DesktopUpdates.describeUpdateErrorCause("404 Not Found\nbody-secret"),
      "404 Not Found",
    );
  });

  it("bounds long messages, parallel failures, and cyclic causes", () => {
    const longError = new Error("x".repeat(10_000));
    const parallel = Cause.combine(Cause.fail(longError), Cause.die(longError));
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(parallel).length, 1024);

    const cyclic = new Error("retry failed");
    cyclic.cause = cyclic;
    assert.include(DesktopUpdates.describeUpdateErrorCause(cyclic), "[truncated cause]");
    assert.isAtMost(DesktopUpdates.describeUpdateErrorCause(cyclic).length, 1024);
  });

  it("does not serialize arbitrary payloads or let unreadable errors break logging", () => {
    assert.equal(DesktopUpdates.describeUpdateErrorCause({ payload: "secret" }), "object");
    const unreadable = Object.defineProperty({}, "message", {
      get() {
        throw new Error("unreadable error");
      },
    });
    assert.equal(DesktopUpdates.describeUpdateErrorCause(unreadable), "UnknownError");
  });
});

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
