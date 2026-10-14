import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const getAccessibilitySupport = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_ACCESSIBILITY_SUPPORT_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: () => Effect.sync(() => Electron.app.accessibilitySupportEnabled),
});

export const installAccessibilitySupport = Effect.fn("desktop.ipc.installAccessibilitySupport")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    yield* ipc.handle(getAccessibilitySupport);
    yield* app.on("accessibility-support-changed", (_event: unknown, enabled: boolean) => {
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IpcChannels.ACCESSIBILITY_SUPPORT_CHANGED_CHANNEL, enabled);
        }
      }
    });
  },
);
