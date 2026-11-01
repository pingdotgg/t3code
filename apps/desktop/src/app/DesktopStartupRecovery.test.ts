import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";

import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import { listen, resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

describe("resolveStartupRecoveryOffer", () => {
  it("offers a newer version before going back", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("offers a retained download after a later check fails", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "error", errorContext: "check", downloadedVersion: "0.1.4" }),
        null,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("waits for the update check before offering to go back", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "checking" }), "0.1.2")).toEqual({
      _tag: "Checking",
    });
  });

  it("offers the last version that started when no update exists", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2")).toEqual({
      _tag: "Reinstall",
      version: "0.1.2",
    });
  });

  it("does not offer an update that already failed to apply here", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({
          status: "downloaded",
          downloadedVersion: "0.1.4",
          notAppliedVersion: "0.1.4",
        }),
        "0.1.2",
      ),
    ).toEqual({ _tag: "Reinstall", version: "0.1.2" });
  });

  it("falls back to the releases page when this version never started", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "disabled" }), "0.1.3")).toEqual({
      _tag: "Releases",
    });
    expect(resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), null)).toEqual({
      _tag: "Releases",
    });
  });
});

it.effect.each([
  { visible: false, started: false },
  { visible: true, started: false },
  { visible: true, started: true },
])("keeps recovery available with visible=$visible and started=$started", ({ visible, started }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const checked = yield* Deferred.make<void>();
      const remembered = yield* Deferred.make<void>();
      const shouldRecover = !visible || !started;
      const closed = Promise.withResolvers<void>();
      const loaded: string[] = [];
      const main = { isDestroyed: () => false, isVisible: () => visible };
      const recovery = {
        isDestroyed: () => false,
        close: () => closed.resolve(),
        loadURL: (url: string) => {
          loaded.push(url);
          return Promise.resolve();
        },
        once: () => {},
        webContents: { setWindowOpenHandler: () => {}, on: () => {} },
      } as unknown as Electron.BrowserWindow;
      const state = yield* DesktopState.DesktopState;
      if (started) yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
      yield* listen.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              readFileString: () => Effect.succeed("0.1.2"),
              writeFileString: () => Deferred.succeed(remembered, undefined).pipe(Effect.asVoid),
            }),
            Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
              appVersion: "0.1.3",
              stateDir: "/task/state",
              logDir: "/task/logs",
              path: { join: (...parts: string[]) => parts.join("/") },
            } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
            Layer.succeed(ElectronApp.ElectronApp, {
              on: () => Effect.void,
            } as unknown as ElectronApp.ElectronApp["Service"]),
            Layer.succeed(
              ElectronShell.ElectronShell,
              {} as ElectronShell.ElectronShell["Service"],
            ),
            Layer.succeed(ElectronTheme.ElectronTheme, {
              shouldUseDarkColors: Effect.succeed(false),
            } as ElectronTheme.ElectronTheme["Service"]),
            Layer.succeed(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome(main),
              create: () => Effect.succeed(recovery),
            } as unknown as ElectronWindow.ElectronWindow["Service"]),
            Layer.succeed(DesktopUpdates.DesktopUpdates, {
              subscribe: Effect.succeed({
                latest: updateState({ status: "disabled" }),
                changes: Stream.empty,
              }),
              check: () => Deferred.succeed(checked, undefined),
            } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
          ),
        ),
      );
      if (started) yield* Deferred.await(remembered);
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "Server failed before readiness",
        output: "Failure details",
      });
      yield* Deferred.await(checked);
      expect(loaded.length).toBe(shouldRecover ? 1 : 0);
      if (shouldRecover) {
        expect(decodeURIComponent(loaded[0]!)).toContain("Failure details");
        yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
        yield* Effect.promise(() => closed.promise);
      }
    }),
  ).pipe(Effect.provide(DesktopState.layer)),
);
