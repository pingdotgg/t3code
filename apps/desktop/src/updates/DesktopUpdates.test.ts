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
import { makeHarness } from "./updatesTestHarness.ts";

// Personal fork: update-available / update-downloaded handlers auto-download and
// auto-install, which chain extra promise callbacks, so a bare yieldNow is not
// enough to observe the settled state.
const flushCallbacks = Effect.promise(() => Promise.resolve()).pipe(Effect.asVoid);

describe("DesktopUpdates", () => {
  it.effect("updates Linux .deb installs and leaves other non-AppImage installs off", () =>
    Effect.gen(function* () {
      const linuxState = (packageType: string | undefined) =>
        Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            return yield* updates.getState;
          }),
        ).pipe(Effect.provide(makeHarness({ platform: "linux", packageType }).layer));

      const deb = yield* linuxState("deb\n");
      assert.equal(deb.status, "idle");

      const unmarked = yield* linuxState(undefined);
      assert.equal(unmarked.status, "disabled");
    }),
  );

  it.effect("keeps the disabled reason available after configuration and channel changes", () => {
    const harness = makeHarness({ env: { T3CODE_DISABLE_AUTO_UPDATE: "true" } });
    const reason = "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const configured = yield* updates.getState;
        assert.equal(configured.message, reason);

        const changed = yield* updates.setChannel("nightly");
        assert.equal(changed.channel, "nightly");
        assert.equal(changed.enabled, false);
        assert.equal(changed.status, "disabled");
        assert.equal(changed.message, reason);
        assert.equal(harness.sentStates.at(-1)?.message, reason);
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(Effect.provide(harness.layer));
  });

  it.effect("subscribe delivers the latest state plus subsequent changes", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const { latest, changes } = yield* updates.subscribe;
        assert.equal(latest.status, "idle");

        const nextState = yield* Stream.runHead(changes).pipe(Effect.forkChild);
        yield* flushCallbacks;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const observed = yield* Fiber.join(nextState);
        assert.equal(Option.getOrThrow(observed).status, "available");
        assert.equal(Option.getOrThrow(observed).availableVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("updates and broadcasts state from updater events", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        // Auto-download starts immediately; mock downloadUpdate resolves without an
        // update-downloaded event, so status stays at downloading.
        assert.equal(state.status, "downloading");
        assert.equal(state.availableVersion, "1.2.4");
        assert.isNotNull(state.checkedAt);
        assert.equal(harness.sentStates.at(-1)?.status, "downloading");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("auto-downloads an update announced while its check still runs", () =>
    Effect.gen(function* () {
      // electron-updater emits update-available from inside checkForUpdates,
      // while the check still holds the action reservation.
      const checkStarted = yield* Deferred.make<void>();
      const releaseCheck = yield* Deferred.make<void>();
      const harness = makeHarness({
        checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
          yield* Deferred.await(checkStarted);
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(checkFiber);
          yield* flushCallbacks;

          const state = yield* updates.getState;
          assert.equal(state.status, "downloading");
          assert.equal(state.availableVersion, "1.2.4");
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("enables full changelog release notes on latest and nightly", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        // MT Code / latest still needs release notes for the update hover.
        assert.equal(harness.fullChangelog(), true);

        // Crossing tracks offers builds only at or above the switch's checked release.
        yield* updates.setChannel("nightly", { minimumVersion: "1.2.4-nightly.20260709.760" });
        assert.equal(harness.fullChangelog(), true);

        harness.emit("update-available", {
          version: "1.2.4-nightly.20260709.766",
          releaseNotes: [
            {
              version: "1.2.4-nightly.20260709.766",
              note: `<h2>What's Changed</h2><ul><li>feat(client): persist offline environment data by <a>@juliusmarminge</a> in <a>#3795</a></li></ul><h2>Full Changelog</h2>`,
            },
            {
              version: "1.2.4-nightly.20260709.765",
              note: "- [codex] Upgrade Clerk stack by @juliusmarminge in #3821",
            },
            { version: "1.2.4-nightly.20260709.764", note: "- Change 764" },
            { version: "1.2.4-nightly.20260709.763", note: "- Change 763" },
            { version: "1.2.4-nightly.20260709.762", note: "- Change 762" },
            { version: "1.2.4-nightly.20260709.761", note: "- Change 761" },
            { version: "1.2.4-nightly.20260709.760", note: "- Change 760" },
          ],
        });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloading");
        assert.deepEqual(state.releaseNotes, [
          {
            version: "1.2.4-nightly.20260709.766",
            items: ["feat(client): persist offline environment data by @juliusmarminge in #3795"],
            totalItems: 1,
            releasedAt: "2026-07-09",
          },
          {
            version: "1.2.4-nightly.20260709.765",
            items: ["[codex] Upgrade Clerk stack by @juliusmarminge in #3821"],
            totalItems: 1,
            releasedAt: "2026-07-09",
          },
          {
            version: "1.2.4-nightly.20260709.764",
            items: ["Change 764"],
            totalItems: 1,
            releasedAt: "2026-07-09",
          },
          {
            version: "1.2.4-nightly.20260709.763",
            items: ["Change 763"],
            totalItems: 1,
            releasedAt: "2026-07-09",
          },
          {
            version: "1.2.4-nightly.20260709.762",
            items: ["Change 762"],
            totalItems: 1,
            releasedAt: "2026-07-09",
          },
          {
            version: "1.2.4-nightly.20260709.761",
            items: ["Change 761"],
            totalItems: 1,
            releasedAt: "2026-07-09",
          },
        ]);
        assert.equal(state.omittedReleaseCount, 1);
        assert.deepEqual(harness.sentStates.at(-1)?.releaseNotes, state.releaseNotes);
        assert.equal(harness.sentStates.at(-1)?.omittedReleaseCount, 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("broadcasts latest-channel release notes for the update hover", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        // Notes arrive oldest-first (the publish script uses `git log --reverse`)
        // and the updater shows newest-first.
        harness.emit("update-available", {
          version: "0.0.37",
          releaseNotes:
            "## What's changed\n- feat: show update changelog on hover\n- fix: clean Computer Use tab groups",
        });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.channel, "latest");
        assert.deepEqual(state.releaseNotes, [
          {
            version: "0.0.37",
            items: ["fix: clean Computer Use tab groups", "feat: show update changelog on hover"],
            totalItems: 2,
          },
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not poll for another update while automatically restarting", () => {
    const harness = makeHarness();
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isFalse((yield* updates.check("poll")).checked);
        assert.equal(harness.quitAndInstalls(), 1);
        assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("auto-downloads an available update once its check finishes", () => {
    const checkStarted = Deferred.makeUnsafe<void>();
    const releaseCheck = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      // electron-updater reports update-available while the check is running.
      checkForUpdates: Effect.sync(() =>
        harness.emit("update-available", {
          version: "1.2.4",
          files: [{ url: "T3-Code-1.2.4.zip", sha512: "sha-1.2.4" }],
        }),
      ).pipe(
        Effect.andThen(Deferred.succeed(checkStarted, undefined)),
        Effect.andThen(Deferred.await(releaseCheck)),
      ),
      downloadUpdate: Effect.sync(() => harness.emit("update-downloaded", { version: "1.2.4" })),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const check = yield* Effect.forkChild(updates.check("startup"));
        yield* Deferred.await(checkStarted);
        yield* flushCallbacks;
        assert.equal(harness.downloadCount(), 0);
        assert.equal((yield* updates.getState).status, "available");

        yield* Deferred.succeed(releaseCheck, undefined);
        yield* Fiber.join(check);
        yield* flushCallbacks;

        assert.equal(harness.downloadCount(), 1);
        assert.equal((yield* updates.getState).downloadedVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  // Personal fork: every available update downloads without a click, whatever
  // electron-updater's cache holds; downloadUpdate decides whether to reuse it.
  it.effect("auto-downloads an available update without a click", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", {
          version: "1.2.5",
          files: [{ url: "T3-Code-1.2.5.zip", sha512: "release-sha" }],
        });
        yield* flushCallbacks;

        assert.equal(harness.downloadCount(), 1);
        assert.equal((yield* updates.getState).status, "downloading");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect.each(["quitting", "newer release", "no longer available"] as const)(
    "abandons a pending auto-download after %s",
    (change) => {
      const checkStarted = Deferred.makeUnsafe<void>();
      const releaseCheck = Deferred.makeUnsafe<void>();
      const harness = makeHarness({
        checkForUpdates: Effect.sync(() =>
          harness.emit("update-available", {
            version: "1.2.4",
            files: [{ url: "T3-Code-1.2.4.zip", sha512: "cached-release" }],
          }),
        ).pipe(
          Effect.andThen(Deferred.succeed(checkStarted, undefined)),
          Effect.andThen(Deferred.await(releaseCheck)),
        ),
      });

      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          const check = yield* Effect.forkChild(updates.check("startup"));
          yield* Deferred.await(checkStarted);
          yield* flushCallbacks;
          assert.equal((yield* updates.getState).status, "available");
          assert.equal(harness.downloadCount(), 0);

          if (change === "quitting") {
            const desktop = yield* DesktopState.DesktopState;
            yield* Ref.set(desktop.quitting, true);
          } else if (change === "newer release") {
            harness.emit("update-available", {
              version: "1.2.5",
              files: [{ url: "T3-Code-1.2.5.zip", sha512: "new-release" }],
            });
          } else {
            harness.emit("update-not-available");
          }
          yield* flushCallbacks;
          yield* Deferred.succeed(releaseCheck, undefined);
          yield* Fiber.join(check);
          yield* flushCallbacks;

          const state = yield* updates.getState;
          if (change === "newer release") {
            // Only the newer release downloads; the stale 1.2.4 attempt is dropped.
            assert.equal(harness.downloadCount(), 1);
            assert.equal(state.availableVersion, "1.2.5");
            assert.equal(state.status, "downloading");
          } else {
            assert.equal(harness.downloadCount(), 0);
            assert.equal(state.status, change === "quitting" ? "available" : "up-to-date");
          }
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    },
  );

  it.effect("preserves a queued installer when the feed has no update", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        harness.emit("update-available", {
          version: "1.2.4",
          releaseNotes: "## What's changed\n- fix: queued update",
        });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.check("poll");
        harness.emit("update-not-available");
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.availableVersion, "1.2.4");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.deepEqual(state.releaseNotes, [
          { version: "1.2.4", items: ["fix: queued update"], totalItems: 1 },
        ]);
        assert.equal(state.omittedReleaseCount, 0);
        assert.equal(state.downloadPercent, 100);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "rejects install while a refresh check is in progress and releases the reservation",
    () =>
      Effect.gen(function* () {
        const checkStarted = yield* Deferred.make<void>();
        const releaseCheck = yield* Deferred.make<void>();
        const harness = makeHarness({
          checkForUpdates: Deferred.succeed(checkStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCheck)),
          ),
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const updates = yield* DesktopUpdates.DesktopUpdates;
            yield* updates.configure;
            const checkFiber = yield* updates.check("manual").pipe(Effect.forkScoped);
            yield* Deferred.await(checkStarted);
            harness.emit("update-downloaded", { version: "1.2.4" });
            yield* flushCallbacks;

            const installResult = yield* updates.install;
            assert.isFalse(installResult.accepted);

            yield* Deferred.succeed(releaseCheck, undefined);
            const checkResult = yield* Fiber.join(checkFiber);
            assert.isTrue(checkResult.checked);

            yield* flushCallbacks;
            assert.equal(harness.quitAndInstalls(), 1);
          }),
        ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
      }),
  );

  it.effect("rejects refresh checks while install is in progress", () =>
    Effect.gen(function* () {
      const installStarted = yield* Deferred.make<void>();
      const releaseInstall = yield* Deferred.make<void>();
      const harness = makeHarness({
        stopBackend: Deferred.succeed(installStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseInstall)),
        ),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          yield* Deferred.await(installStarted);

          const checkResult = yield* updates.check("manual");
          assert.isFalse(checkResult.checked);
          assert.equal(harness.checkCount(), 0);

          yield* Deferred.succeed(releaseInstall, undefined);
          yield* flushCallbacks;
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("ignores background updater errors after automatic restart begins", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        harness.emit("error", new Error("background updater failure"));
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.equal(state.errorContext, "install");

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("logs the redacted cause of a rejected update check", () => {
    const cause = Object.assign(
      new Error("request failed for https://user:secret@example.com/update?token=secret"),
      { code: "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" },
    );
    const updaterError = new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause,
    });
    const harness = makeHarness({ checkForUpdates: Effect.fail(updaterError) });
    const loggedAnnotations: Array<Record<string, unknown>> = [];
    const logger = Logger.make(({ fiber }) => {
      const annotations = fiber.getRef(References.CurrentLogAnnotations);
      if (annotations.errorTag === "ElectronUpdaterCheckForUpdatesError") {
        loggedAnnotations.push(annotations);
      }
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        yield* updates.check("manual");

        const state = yield* updates.getState;
        const loggedAnnotation = loggedAnnotations.at(-1);
        assert.isDefined(loggedAnnotation);
        assert.equal(loggedAnnotation.errorTag, "ElectronUpdaterCheckForUpdatesError");
        assert.isNull(loggedAnnotation.channel);
        assert.equal(
          loggedAnnotation.cause,
          "Error [ERR_UPDATER_LATEST_VERSION_NOT_FOUND]: request failed for [redacted URL]",
        );
        assert.notProperty(loggedAnnotation, "error");
        assert.notInclude(Object.values(loggedAnnotation).map(String).join(" "), "secret");
        assert.equal(
          state.message,
          "Electron updater failed to check for updates on channel default.",
        );
        assert.notInclude(state.message ?? "", "secret");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          TestClock.layer(),
          harness.layer,
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("recovers download state after an unexpected setup failure", () => {
    let disableDifferentialCalls = 0;
    const harness = makeHarness({
      setDisableDifferentialDownload: Effect.suspend(() => {
        disableDifferentialCalls += 1;
        return disableDifferentialCalls === 1
          ? Effect.void
          : Effect.die(new Error("download setup failed"));
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;

        // Auto-download already attempted and failed during update-available handling.
        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "available");
        assert.equal(failedState.errorContext, "download");
        assert.equal(failedState.message, "Desktop update download action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores download state and permits retry after interruption", () =>
    Effect.gen(function* () {
      const actionStarted = yield* Deferred.make<void>();
      let disableDifferentialCalls = 0;
      const harness = makeHarness({
        setDisableDifferentialDownload: Effect.suspend(() => {
          disableDifferentialCalls += 1;
          if (disableDifferentialCalls === 1) {
            // configure
            return Effect.void;
          }
          if (disableDifferentialCalls === 2) {
            // auto-download from update-available: fail so status stays available
            return Effect.die(new Error("auto-download setup failed"));
          }
          if (disableDifferentialCalls === 3) {
            // first manual download: hang so we can interrupt
            return Deferred.succeed(actionStarted, undefined).pipe(Effect.andThen(Effect.never));
          }
          // retry after interrupt
          return Effect.void;
        }),
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;
          harness.emit("update-available", { version: "1.2.4" });
          yield* flushCallbacks;

          const afterAutoDownload = yield* updates.getState;
          assert.equal(afterAutoDownload.status, "available");

          const downloadFiber = yield* updates.download.pipe(Effect.forkScoped);
          yield* Deferred.await(actionStarted);
          yield* Fiber.interrupt(downloadFiber);

          const interruptedState = yield* updates.getState;
          assert.equal(interruptedState.status, "available");
          assert.equal(interruptedState.errorContext, "download");
          assert.equal(
            interruptedState.message,
            "Desktop update download action failed unexpectedly.",
          );

          const retry = yield* updates.download;
          assert.isTrue(retry.accepted);
          assert.isTrue(retry.completed);
        }),
      ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
    }),
  );

  it.effect("clears quitting state after an unexpected install setup failure", () => {
    const harness = makeHarness({
      stopBackend: Effect.die(new Error("backend stop failed")),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        // Auto-install already ran (and failed) on update-downloaded.
        assert.isFalse(yield* Ref.get(desktopState.quitting));

        const failedState = yield* updates.getState;
        assert.equal(failedState.status, "downloaded");
        assert.equal(failedState.errorContext, "install");
        assert.equal(failedState.message, "Desktop update install action failed unexpectedly.");

        const changedState = yield* updates.setChannel("nightly");
        assert.equal(changedState.channel, "nightly");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("auto-installs and relaunches after update-downloaded", () => {
    let stopCalls = 0;
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        stopCalls += 1;
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.status, "downloaded");
        assert.equal(state.downloadedVersion, "1.2.4");
        assert.equal(stopCalls, 1);
        // Successful quitAndInstall leaves quitting=true (app is exiting).
        assert.isTrue(yield* Ref.get(desktopState.quitting));
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
  it.effect("marks the backend stop for an install as an update restart", () => {
    let markersAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        markersAtStop = [...harness.updateRestartMarkers];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.equal(harness.quitAndInstalls(), 1);
        assert.deepEqual(markersAtStop, [
          environment.path.join(environment.baseDir, "runtime", DESKTOP_UPDATE_RESTART_MARKER_FILE),
        ]);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("records the version an install hands to the installer", () => {
    let recordsAtStop: ReadonlyArray<string> = [];
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        recordsAtStop = [...harness.installRecords.values()];
      }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        // A finished download installs on its own, handing the version over.
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        assert.deepEqual(
          recordsAtStop.map((record) => JSON.parse(record)),
          [{ fromVersion: "1.2.3", targetVersion: "1.2.4" }],
        );
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("flags an install that did not apply and keeps the flag through checks", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).notAppliedVersion, "1.2.4");
        assert.isDefined(harness.previousInstallRecord());

        harness.emit("update-available", { version: "1.2.4" });
        yield* flushCallbacks;
        const state = yield* updates.getState;
        // An available update starts downloading at once.
        assert.equal(state.status, "downloading");
        assert.equal(state.notAppliedVersion, "1.2.4");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  // regression: #19291 an install that did apply was still flagged as not applied
  it.effect("does not flag an install that applied", () => {
    const harness = makeHarness({
      installRecord: JSON.stringify({ fromVersion: "1.2.2", targetVersion: "1.2.3" }),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.isUndefined((yield* updates.getState).notAppliedVersion);
        assert.isUndefined(harness.previousInstallRecord());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("drops the update restart marker when an install is interrupted", () => {
    let markerPresentAtStop = false;
    const harness = makeHarness({
      stopBackend: Effect.sync(() => {
        markerPresentAtStop = harness.updateRestartMarkers.size === 1;
      }).pipe(Effect.andThen(Effect.interrupt)),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.isTrue(markerPresentAtStop);
        assert.equal(harness.updateRestartMarkers.size, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps windows and restarts backends when quitAndInstall fails", () => {
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const desktopState = yield* DesktopState.DesktopState;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        // Personal fork: auto-install already ran on update-downloaded, failed, and
        // recovered the backend without quitting.
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);

        const result = yield* updates.install;
        assert.isTrue(result.accepted);
        assert.isFalse(yield* Ref.get(desktopState.quitting));
        assert.deepEqual(harness.installSteps, [
          "quitAndInstall",
          "startBackend",
          "quitAndInstall",
          "startBackend",
        ]);
        // The restarted old backend must release its tunnel on a later quit.
        assert.equal(harness.updateRestartMarkers.size, 0);
        assert.equal(harness.installRecords.size, 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("keeps the disabled primary stopped when quitAndInstall fails", () => {
    const harness = makeHarness({
      backendDesiredRunning: false,
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        const pool = yield* DesktopBackendPool.DesktopBackendPool;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        const result = yield* updates.install;
        assert.equal(result.state.errorContext, "install");
        // Personal fork: update-downloaded already auto-installed once (and failed),
        // so the manual install is a retry; neither attempt restarts the backend.
        assert.isNotEmpty(harness.installSteps);
        assert.isTrue(harness.installSteps.every((step) => step === "quitAndInstall"));
        assert.isFalse((yield* (yield* pool.primary).snapshot).desiredRunning);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("restores only desired-running instances after an installer error event", () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const makeInstance = (id: DesktopBackendPool.BackendInstanceId, initiallyRunning: boolean) => {
      let desiredRunning = initiallyRunning;
      return {
        id,
        label: Effect.succeed(id),
        currentConfig: Effect.succeedNone,
        start: Effect.sync(() => {
          starts.push(id);
          desiredRunning = true;
        }),
        stop: () =>
          Effect.sync(() => {
            stops.push(id);
            desiredRunning = false;
          }),
        snapshot: Effect.sync(() => ({
          desiredRunning,
          ready: false,
          activePid: Option.none(),
          restartAttempt: 0,
          restartScheduled: false,
        })),
        waitForReady: () => Effect.succeed(true),
      } satisfies DesktopBackendPool.DesktopBackendInstance;
    };
    const primary = makeInstance(DesktopBackendPool.PRIMARY_INSTANCE_ID, false);
    const wsl = makeInstance(DesktopBackendPool.BackendInstanceId("wsl:default"), true);
    const harness = makeHarness({ backendInstances: [primary, wsl] });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* updates.install;
        assert.sameMembers(stops, [primary.id, wsl.id]);
        assert.isFalse((yield* wsl.snapshot).desiredRunning);
        const { changes } = yield* updates.subscribe;
        const recovered = yield* Stream.runHead(changes).pipe(Effect.forkChild);
        yield* flushCallbacks;
        harness.emit("error", new Error("native installer refused"));
        assert.equal(Option.getOrThrow(yield* Fiber.join(recovered)).errorContext, "install");

        assert.deepEqual(starts, [wsl.id]);
        assert.isFalse((yield* primary.snapshot).desiredRunning);
        assert.isTrue((yield* wsl.snapshot).desiredRunning);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("holds the install reservation until failed-install recovery finishes", () => {
    const recoveryStarted = Deferred.makeUnsafe<void>();
    const releaseRecovery = Deferred.makeUnsafe<void>();
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
      startBackend: Deferred.succeed(recoveryStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRecovery)),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        // Personal fork: the auto-install triggered by update-downloaded is the
        // failing install whose recovery holds the reservation.
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* Deferred.await(recoveryStarted);
        assert.isFalse(yield* updates.isInstallActive);

        const overlappingInstall = yield* updates.install;
        assert.isFalse(overlappingInstall.accepted);
        assert.equal(harness.quitAndInstalls(), 1);
        harness.emit("error", new Error("duplicate native installer error"));
        yield* flushCallbacks;
        assert.deepEqual(harness.installSteps, ["quitAndInstall", "startBackend"]);

        yield* Deferred.succeed(releaseRecovery, undefined);
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).errorContext, "install");

        const retry = yield* updates.install;
        assert.isTrue(retry.accepted);
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("rejects a prepared install when the downloaded version changed", () => {
    // Personal fork: auto-install runs on update-downloaded; make it fail so the
    // app is still running and the version guard is what refuses the install.
    const harness = makeHarness({
      quitAndInstall: Effect.fail(
        new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
          channel: "latest",
          isSilent: true,
          isForceRunAfter: true,
          cause: new Error("installer refused"),
        }),
      ),
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        harness.emit("update-downloaded", { version: "1.2.5" });
        yield* flushCallbacks;
        assert.equal(harness.quitAndInstalls(), 1);

        const result = yield* updates.installPrepared("1.2.4");
        assert.isFalse(result.accepted);
        assert.equal(harness.quitAndInstalls(), 1);

        // Same state, matching version: the guard (not the state) was the reason.
        const matching = yield* updates.installPrepared("1.2.5");
        assert.isTrue(matching.accepted);
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("persists channel changes through the settings service", () => {
    const harness = makeHarness({ beforeSetUpdateChannel: Effect.void });

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("nightly");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "nightly");
        assert.equal(persistedSettings.updateChannel, "nightly");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, true);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("ignores a finished download from a track it no longer follows", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        // A backed-out switch's download keeps reporting progress until it finishes.
        harness.emit("download-progress", { percent: 40 });
        yield* flushCallbacks;
        harness.emit("update-downloaded", { version: "1.2.4-nightly.20261027.1" });
        yield* flushCallbacks;

        const state = yield* updates.getState;
        assert.equal(state.downloadedVersion, null);
        assert.notEqual(state.status, "downloading");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("offers older releases only to checks that leave the running build's track", () => {
    const harness = makeHarness({ beforeSetUpdateChannel: Effect.void });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const before = harness.checkAllowedDowngrade.length;
        yield* updates.setChannel("nightly");
        yield* updates.setChannel("latest");
        yield* updates.check("remote-update", { allowDowngrade: true });

        // Back on its own Stable track the build never needs an older release.
        assert.deepEqual(harness.checkAllowedDowngrade.slice(before), [true, false, true]);
        assert.isFalse(harness.allowDowngrade());
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("re-checks a saved track that differs from the running build's track", () => {
    const harness = makeHarness({
      appVersion: "1.2.4-nightly.20261027.1",
      beforeSetUpdateChannel: Effect.void,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.setChannel("latest");
        const checks = harness.checkCount();

        yield* updates.setChannel("latest");

        assert.equal(harness.checkCount(), checks + 1);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("does not persist an unchanged update channel as a user preference", () => {
    const harness = makeHarness();

    return Effect.scoped(
      Effect.gen(function* () {
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.setChannel("latest");
        const persistedSettings = yield* settings.get;

        assert.equal(state.channel, "latest");
        assert.equal(persistedSettings.updateChannel, "latest");
        assert.equal(persistedSettings.updateChannelConfiguredByUser, false);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

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
