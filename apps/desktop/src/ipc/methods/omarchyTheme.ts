import { PickedThemeFileSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../../app/DesktopObservability.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { readOmarchyThemeFile, watchOmarchyTheme } from "../../appearance/OmarchyTheme.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const { logWarning } = makeComponentLogger("desktop-omarchy-theme");

export const getOmarchyTheme = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_OMARCHY_THEME_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.NullOr(PickedThemeFileSchema),
  handler: Effect.fn("desktop.ipc.omarchyTheme.get")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return yield* readOmarchyThemeFile({
      homeDirectory: environment.homeDirectory,
      platform: environment.platform,
    });
  }),
});

export const installOmarchyThemeWatcher = Effect.fn("desktop.omarchyTheme.installWatcher")(
  function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (environment.platform !== "linux") return;
    const electronWindow = yield* ElectronWindow.ElectronWindow;

    yield* watchOmarchyTheme(
      {
        homeDirectory: environment.homeDirectory,
        platform: environment.platform,
      },
      (theme) => electronWindow.sendAll(IpcChannels.OMARCHY_THEME_CHANGE_CHANNEL, theme),
    ).pipe(
      Effect.catch((error) =>
        logWarning("Omarchy theme watcher stopped", { message: error.message }),
      ),
      Effect.forkScoped,
    );
  },
);
