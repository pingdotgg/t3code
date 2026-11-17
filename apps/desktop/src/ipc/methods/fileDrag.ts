import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import { getHostEnvironmentId } from "./localEnvironment.ts";

export const startFileDrag = makeIpcMethod({
  channel: IpcChannels.START_FILE_DRAG_CHANNEL,
  payload: Schema.Struct({ environmentId: Schema.String, path: Schema.String }),
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.fileDrag.start")(function* (input, event) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "darwin" || !environment.path.isAbsolute(input.path)) return false;
    const hostEnvironmentId = yield* getHostEnvironmentId.handler(undefined);
    if (hostEnvironmentId === null || input.environmentId !== hostEnvironmentId) return false;
    const window = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (Option.isNone(window) || event?.sender.id !== window.value.webContents.id) return false;
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(input.path))) return false;
    return yield* Effect.promise(async () => {
      try {
        const icon = await Electron.app.getFileIcon(input.path, { size: "normal" });
        window.value.webContents.startDrag({ file: input.path, icon });
        return true;
      } catch {
        return false;
      }
    });
  }),
});
