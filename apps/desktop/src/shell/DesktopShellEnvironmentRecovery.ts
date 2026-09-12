import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopShellEnvironment from "./DesktopShellEnvironment.ts";

export const recoverShellEnvironment = Effect.fn("desktop.startup.recoverShellEnvironment")(
  function* () {
    const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    while (true) {
      const { response } = yield* electronDialog.showMessageBox({
        type: "warning",
        title: "T3 Code",
        message: "The shell environment could not be captured.",
        detail:
          "Installed agent CLIs may appear missing because T3 Code could not read your shell's PATH. Retry after checking your shell configuration, or continue and set an absolute CLI path in provider settings.",
        buttons: ["Retry", "Continue"],
        defaultId: 0,
        cancelId: 1,
      });
      if (response !== 0) return;
      const result = yield* Effect.result(shellEnvironment.installIntoProcess);
      if (Result.isSuccess(result)) return;
    }
  },
);
