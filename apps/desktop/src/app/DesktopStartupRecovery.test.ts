import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { vi } from "vite-plus/test";

import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import { listen, resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

vi.mock("../i18n/messages.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../i18n/messages.ts")>()),
  activeUiLocale: () => "he",
}));

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

  it("blames the managed policy unless a newer version can read it", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
        true,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
    expect(
      resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2", true),
    ).toEqual({ _tag: "ManagedPolicy" });
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
  { visible: false, started: false, closeMain: false, output: "Failure details" },
  { visible: true, started: false, closeMain: false, output: "" },
  { visible: true, started: true, closeMain: false, output: "Failure details" },
  { visible: true, started: false, closeMain: true, output: "Failure details" },
])("closes recovery safely with closeMain=$closeMain", ({ visible, started, closeMain, output }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const checked = yield* Deferred.make<void>();
      const remembered = yield* Deferred.make<void>();
      const shouldRecover = !visible || !started;
      const closed = Promise.withResolvers<void>();
      const loaded: string[] = [];
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
      const mainListeners = new Map<string, () => void>();
      let closeCount = 0;
      let mainVisible = visible;
      const main = {
        isDestroyed: () => false,
        isVisible: () => mainVisible,
        on: (event: string, listener: () => void) => mainListeners.set(event, listener),
        once: (event: string, listener: () => void) => mainListeners.set(event, listener),
      } as unknown as Electron.BrowserWindow;
      const mainRef = yield* Ref.make(Option.some(main));
      const recovery = {
        isDestroyed: () => false,
        close: () => {
          closeCount++;
          closed.resolve();
        },
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
              on: (event: string, listener: (...args: readonly unknown[]) => void) =>
                Effect.sync(() => {
                  appListeners.set(event, listener);
                }),
            } as unknown as ElectronApp.ElectronApp["Service"]),
            Layer.succeed(
              ElectronShell.ElectronShell,
              {} as ElectronShell.ElectronShell["Service"],
            ),
            Layer.succeed(ElectronTheme.ElectronTheme, {
              shouldUseDarkColors: Effect.succeed(false),
            } as ElectronTheme.ElectronTheme["Service"]),
            Layer.succeed(ElectronWindow.ElectronWindow, {
              main: Ref.get(mainRef),
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
      appListeners.get("browser-window-created")?.({}, main);
      if (started) yield* Deferred.await(remembered);
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "Server failed before readiness",
        managedPolicy: false,
        output,
      });
      yield* Deferred.await(checked);
      expect(loaded.length).toBe(shouldRecover ? 1 : 0);
      if (shouldRecover) {
        const html = decodeURIComponent(loaded[0]!);
        expect(html).toContain('<html lang="he" dir="rtl">');
        expect(html).toContain('<p dir="auto">Server failed before readiness</p>');
        expect(html).toContain("\u2066/task/logs\u2069");
        if (output) expect(html).toContain('<pre dir="ltr">Failure details</pre>');
        else expect(html).toMatch(/<pre>[^<]+<\/pre>/);
        if (closeMain) yield* Ref.set(mainRef, Option.none());
        yield* SubscriptionRef.set(state.primaryBackendStartup, { _tag: "Ready" });
        yield* Deferred.await(remembered);
        if (closeMain || !visible) {
          expect(closeCount).toBe(0);
          if (closeMain) {
            yield* Ref.set(mainRef, Option.some(main));
            mainVisible = false;
            appListeners.get("browser-window-created")?.({}, main);
          }
          mainListeners.get("ready-to-show")?.();
          expect(closeCount).toBe(0);
          mainVisible = true;
          const show = mainListeners.get("show");
          expect(show).toBeDefined();
          show!();
        }
        yield* Effect.promise(() => closed.promise);
        expect(closeCount).toBe(1);
      }
    }),
  ).pipe(Effect.provide(DesktopState.layer)),
);

it.effect("installs the build the update action downloaded, not the one it offered", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const installed = yield* Deferred.make<string>();
      const shown = yield* Deferred.make<void>();
      let navigate: ((event: { preventDefault: () => void }, url: string) => void) | undefined;
      const recovery = {
        isDestroyed: () => false,
        loadURL: () => Promise.resolve(),
        once: () => {},
        webContents: {
          setWindowOpenHandler: () => {},
          on: (_event: string, listener: typeof navigate) => {
            navigate = listener;
            Deferred.doneUnsafe(shown, Effect.void);
          },
        },
      } as unknown as Electron.BrowserWindow;
      const offered = updateState({ status: "available", availableVersion: "0.1.4" });
      const state = yield* DesktopState.DesktopState;
      yield* listen.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({ readFileString: () => Effect.succeed("0.1.3") }),
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
              main: Effect.succeedNone,
              create: () => Effect.succeed(recovery),
            } as unknown as ElectronWindow.ElectronWindow["Service"]),
            Layer.succeed(DesktopUpdates.DesktopUpdates, {
              subscribe: Effect.succeed({ latest: offered, changes: Stream.empty }),
              check: () => Effect.void,
              getState: Effect.succeed(offered),
              // A release published since the offer: the download fetches it instead.
              download: Effect.succeed({
                accepted: true,
                completed: true,
                state: updateState({ status: "downloaded", downloadedVersion: "0.1.5" }),
              }),
              installPrepared: (version: string) => Deferred.succeed(installed, version),
            } as unknown as DesktopUpdates.DesktopUpdates["Service"]),
          ),
        ),
      );
      yield* SubscriptionRef.set(state.primaryBackendStartup, {
        _tag: "Failing",
        reason: "Server failed before readiness",
        managedPolicy: false,
        output: "Failure details",
      });
      yield* Deferred.await(shown);
      navigate!({ preventDefault: () => {} }, "https://startup-recovery.invalid/update");
      expect(yield* Deferred.await(installed)).toBe("0.1.5");
    }),
  ).pipe(Effect.provide(DesktopState.layer)),
);
