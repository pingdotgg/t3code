import {
  DesktopDictationInput,
  DesktopDictationResult,
  DEFAULT_CLIENT_SETTINGS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopDictation from "../../voice/DesktopDictation.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

export const dictation = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DICTATION_CHANNEL,
  payload: DesktopDictationInput,
  result: DesktopDictationResult,
  handler: Effect.fn("desktop.ipc.dictation")(function* (input, event) {
    const service = yield* DesktopDictation.DesktopDictation;
    if (input.action === "choose-executable" || input.action === "reset-executable") {
      const window = yield* (yield* ElectronWindow.ElectronWindow).main;
      if (Option.isNone(window) || window.value.webContents.id !== event?.sender.id)
        return {
          state: "unavailable" as const,
          message: "Choose the executable from the main T3 Code window.",
          downloadedBytes: 0,
          totalBytes: 0,
        };
      const settings = yield* DesktopClientSettings.DesktopClientSettings;
      const current = Option.getOrElse(yield* settings.get, () => DEFAULT_CLIENT_SETTINGS);
      const paths =
        input.action === "reset-executable"
          ? [""]
          : yield* (yield* ElectronDialog.ElectronDialog).pickFiles({
              owner: window,
              defaultPath: current.dictationExecutablePath
                ? Option.some(current.dictationExecutablePath)
                : Option.none(),
              filters: [],
              multiple: false,
            });
      const executablePath = paths[0];
      if (executablePath === undefined)
        return {
          state: "cancelled" as const,
          message: "Executable selection cancelled.",
          downloadedBytes: 0,
          totalBytes: 0,
        };
      // Read again after the dialog so unrelated settings changed while it was
      // open are preserved. Only the native dialog supplies this path.
      const latest = Option.getOrElse(yield* settings.get, () => DEFAULT_CLIENT_SETTINGS);
      yield* settings.set({ ...latest, dictationExecutablePath: executablePath });
      const status = yield* service.execute({ action: "status" }, event!.sender.id);
      return { ...status, executablePath };
    }
    return yield* service.execute(input, event?.sender.id ?? -1);
  }),
});
