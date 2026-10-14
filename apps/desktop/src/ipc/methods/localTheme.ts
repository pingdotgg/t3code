import { DesktopLocalThemeStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopLocalTheme from "../../theme/DesktopLocalTheme.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getLocalTheme = makeIpcMethod({
  channel: IpcChannels.GET_LOCAL_THEME_CHANNEL,
  payload: Schema.Void,
  result: DesktopLocalThemeStateSchema,
  handler: Effect.fn("desktop.ipc.localTheme.get")(function* () {
    return yield* (yield* DesktopLocalTheme.DesktopLocalTheme).current;
  }),
});

export const setLocalThemeFile = makeIpcMethod({
  channel: IpcChannels.SET_LOCAL_THEME_FILE_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: DesktopLocalThemeStateSchema,
  handler: Effect.fn("desktop.ipc.localTheme.setFile")(function* (path) {
    return yield* (yield* DesktopLocalTheme.DesktopLocalTheme).setFile(path);
  }),
});

export const pickLocalThemeFile = makeIpcMethod({
  channel: IpcChannels.PICK_LOCAL_THEME_FILE_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.localTheme.pickFile")(function* () {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const windows = yield* ElectronWindow.ElectronWindow;
    const themes = yield* DesktopLocalTheme.DesktopLocalTheme;
    const state = yield* themes.current;
    const paths = yield* dialog.pickFiles({
      owner: yield* windows.currentMainOrFirst,
      defaultPath: Option.fromNullishOr(state.filePath),
      filters: [{ name: "T3 Code theme", extensions: ["json"] }],
      multiple: false,
    });
    return paths[0] ?? null;
  }),
});
