import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as Electron from "electron";
import { HostProcessArguments } from "@t3tools/shared/hostProcess";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { desktopOpenUrlBuffer } from "./DesktopDeepLink.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

describe("DesktopLifecycle", () => {
  for (const platform of ["darwin", "win32", "linux"] satisfies ReadonlyArray<NodeJS.Platform>) {
    it.effect(`lets the updater's quit event proceed on ${platform}`, () => {
      const appListeners = new Map<string, (...args: readonly unknown[]) => void>();

      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        metadata: Effect.die("unexpected metadata read"),
        name: Effect.succeed("T3 Code"),
        whenReady: Effect.void,
        quit: Effect.void,
        exit: () => Effect.void,
        relaunch: () => Effect.void,
        setPath: () => Effect.void,
        setName: () => Effect.void,
        setAboutPanelOptions: () => Effect.void,
        setAppUserModelId: () => Effect.void,
        getAppMetrics: Effect.succeed([]),
        isDefaultProtocolClient: () => Effect.succeed(false),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
        setDesktopName: () => Effect.void,
        setDockIcon: () => Effect.void,
        appendCommandLineSwitch: () => Effect.void,
        removeCommandLineSwitch: () => Effect.void,
        onBeforeQuitForUpdate: (listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set("before-quit-for-update", listener);
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete("before-quit-for-update");
              }),
          ).pipe(Effect.asVoid),
        on: (eventName, listener) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              appListeners.set(
                eventName,
                listener as unknown as (...args: readonly unknown[]) => void,
              );
            }),
            () =>
              Effect.sync(() => {
                appListeners.delete(eventName);
              }),
          ).pipe(Effect.asVoid),
      } satisfies ElectronApp.ElectronApp["Service"]);

      const electronThemeLayer = Layer.succeed(ElectronTheme.ElectronTheme, {
        shouldUseDarkColors: Effect.succeed(false),
        setSource: () => Effect.void,
        onUpdated: () => Effect.void,
      });

      const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
        createMain: Effect.die("unexpected window creation"),
        ensureMain: Effect.die("unexpected window creation"),
        revealOrCreateMain: Effect.die("unexpected window creation"),
        activate: Effect.void,
        createMainIfBackendReady: Effect.void,
        showConnectingSplash: Effect.void,
        handleBackendReady: () => Effect.void,
        handleBackendNotReady: Effect.void,
        flushMainWindowBounds: Effect.void,
        dispatchDeepLink: () => Effect.void,
        dispatchMenuAction: () => Effect.void,
        zoomMain: () => Effect.void,
        syncAppearance: Effect.void,
      });

      const environmentLayer = Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
        platform,
        isDevelopment: false,
      } as DesktopEnvironment.DesktopEnvironment["Service"]);

      const layer = DesktopLifecycle.layer.pipe(
        Layer.provideMerge(electronAppLayer),
        Layer.provideMerge(electronThemeLayer),
        Layer.provideMerge(desktopWindowLayer),
        Layer.provideMerge(environmentLayer),
        Layer.provideMerge(DesktopShutdown.layer),
        Layer.provideMerge(DesktopState.layer),
        Layer.provideMerge(Layer.succeed(HostProcessArguments, [])),
      );

      return Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
          yield* lifecycle.register;

          appListeners.get("before-quit-for-update")?.();

          let prevented = false;
          const event = {
            preventDefault: () => {
              prevented = true;
            },
          } as Electron.Event;
          appListeners.get("before-quit")?.(event);

          assert.isFalse(
            prevented,
            "cancelling this event prevents the updater from completing its relaunch",
          );

          const state = yield* DesktopState.DesktopState;
          assert.isTrue(yield* Ref.get(state.quitting));
        }),
      ).pipe(Effect.provide(layer));
    });
  }

  it.effect("dispatches initial, macOS, and second-instance thread deep links", () => {
    const appListeners = new Map<string, (...args: readonly unknown[]) => void>();
    const targets: unknown[] = [];
    const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
      metadata: Effect.die("unexpected metadata read"),
      name: Effect.succeed("T3 Code"),
      whenReady: Effect.void,
      quit: Effect.void,
      exit: () => Effect.void,
      relaunch: () => Effect.void,
      setPath: () => Effect.void,
      setName: () => Effect.void,
      setAboutPanelOptions: () => Effect.void,
      setAppUserModelId: () => Effect.void,
      getAppMetrics: Effect.succeed([]),
      isDefaultProtocolClient: () => Effect.succeed(false),
      setAsDefaultProtocolClient: () => Effect.succeed(true),
      setDesktopName: () => Effect.void,
      setDockIcon: () => Effect.void,
      appendCommandLineSwitch: () => Effect.void,
      onBeforeQuitForUpdate: () => Effect.void,
      on: (eventName, listener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            appListeners.set(
              eventName,
              listener as unknown as (...args: readonly unknown[]) => void,
            );
          }),
          () =>
            Effect.sync(() => {
              appListeners.delete(eventName);
            }),
        ).pipe(Effect.asVoid),
    } satisfies ElectronApp.ElectronApp["Service"]);
    const desktopWindowLayer = Layer.succeed(DesktopWindow.DesktopWindow, {
      createMain: Effect.die("unexpected window creation"),
      ensureMain: Effect.die("unexpected window creation"),
      revealOrCreateMain: Effect.die("unexpected window creation"),
      activate: Effect.void,
      createMainIfBackendReady: Effect.void,
      showConnectingSplash: Effect.void,
      handleBackendReady: () => Effect.void,
      handleBackendNotReady: Effect.void,
      flushMainWindowBounds: Effect.void,
      dispatchDeepLink: (target) =>
        Effect.sync(() => {
          targets.push(target);
        }),
      dispatchMenuAction: () => Effect.void,
      syncAppearance: Effect.void,
    });
    const layer = DesktopLifecycle.layer.pipe(
      Layer.provideMerge(electronAppLayer),
      Layer.provideMerge(
        Layer.succeed(ElectronTheme.ElectronTheme, {
          shouldUseDarkColors: Effect.succeed(false),
          setSource: () => Effect.void,
          onUpdated: () => Effect.void,
        }),
      ),
      Layer.provideMerge(desktopWindowLayer),
      Layer.provideMerge(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
      Layer.provideMerge(DesktopShutdown.layer),
      Layer.provideMerge(DesktopState.layer),
      Layer.provideMerge(
        Layer.succeed(HostProcessArguments, [
          "/Applications/T3 Code.app/Contents/MacOS/T3 Code",
          "t3code://threads/environment-initial/thread-initial",
        ]),
      ),
    );

    return Effect.scoped(
      Effect.gen(function* () {
        let prevented = false;
        desktopOpenUrlBuffer.handle(
          {
            preventDefault: () => {
              prevented = true;
            },
          },
          "t3code://threads/environment-open-url/thread-open-url",
        );

        const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
        yield* lifecycle.register;

        appListeners.get("second-instance")?.({} as Electron.Event, [
          "T3 Code",
          "t3code://threads/environment-second/thread-second",
        ]);
        yield* Effect.promise(() => Promise.resolve());

        assert.isTrue(prevented);
        assert.deepEqual(targets, [
          {
            type: "thread",
            environmentId: "environment-initial",
            threadId: "thread-initial",
          },
          {
            type: "thread",
            environmentId: "environment-open-url",
            threadId: "thread-open-url",
          },
          {
            type: "thread",
            environmentId: "environment-second",
            threadId: "thread-second",
          },
        ]);
      }),
    ).pipe(Effect.provide(layer));
  });
});
