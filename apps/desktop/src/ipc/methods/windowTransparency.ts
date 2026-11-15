import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import {
  nativeWindowOpacity,
  resolveWindowTransparencyMode,
  usesNativeWindowOpacity,
  wasCreatedTransparent,
} from "../../window/WindowTransparency.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getWindowTransparency = makeSyncIpcMethod({
  channel: IpcChannels.GET_WINDOW_TRANSPARENCY_CHANNEL,
  result: Schema.Literals(["native", "compositor", "restart-required"]),
  handler: Effect.fn("desktop.ipc.windowTransparency.get")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const main = yield* electronWindow.main;
    return resolveWindowTransparencyMode({
      platform: environment.platform,
      createdTransparent: Option.match(main, {
        onNone: () => false,
        onSome: (window) => wasCreatedTransparent(window),
      }),
    });
  }),
});

/** Linux creates a transparent window only at startup, so the first fade needs a relaunch. */
export const relaunchForWindowOpacity = makeIpcMethod({
  channel: IpcChannels.RELAUNCH_FOR_WINDOW_OPACITY_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windowTransparency.relaunch")(function* () {
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("windowOpacity");
  }),
});

/** Applies `windowOpacity` to the main window where the OS fades windows itself. */
export const applyNativeWindowOpacity = Effect.fn("desktop.windowTransparency.applyNative")(
  function* (opacity: number | undefined) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (!usesNativeWindowOpacity(environment.platform)) return;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const main = yield* electronWindow.main;
    if (Option.isNone(main) || main.value.isDestroyed()) return;
    main.value.setOpacity(nativeWindowOpacity(opacity));
  },
);
