import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import * as Electron from "electron";

import { watchLinuxNotificationService } from "./LinuxNotificationService.ts";

export class ElectronNotifications extends Context.Service<
  ElectronNotifications,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronNotifications") {}

type WatchNotificationService = () => {
  readonly available: () => boolean;
  readonly stop: () => void;
};

export const makeWith = (watchNotificationService: WatchNotificationService | undefined) =>
  ElectronNotifications.of({
    configure: Effect.gen(function* () {
      if (!watchNotificationService) return;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let watcher: ReturnType<WatchNotificationService> | undefined;
          try {
            watcher = watchNotificationService();
          } catch {
            watcher = undefined;
          }
          // Renderers see "denied" until the service answers, so `new Notification` never reaches
          // libnotify while activation can still stall Electron's main thread.
          Electron.session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
            permission === "notifications"
              ? watcher?.available() === true
              : // Electron's answer when no check handler is installed.
                permission !== "deprecated-sync-clipboard-read",
          );
          return watcher;
        }),
        (watcher) =>
          Effect.sync(() => {
            Electron.session.defaultSession.setPermissionCheckHandler(null);
            watcher?.stop();
          }),
      );
    }).pipe(Effect.withSpan("desktop.electronNotifications.configure")),
  });

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  return makeWith(platform === "linux" ? watchLinuxNotificationService : undefined);
});

export const layer = Layer.effect(ElectronNotifications, make);
