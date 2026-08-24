import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import type { ExistingLocalBackendAttachment } from "./DesktopExistingLocalBackend.ts";

export type ExistingLocalBackendStartupSelection =
  | {
      readonly _tag: "Continue";
      readonly attachment: Option.Option<ExistingLocalBackendAttachment>;
    }
  | { readonly _tag: "Quit" };

const TRY_AGAIN_BUTTON = 0;
const START_SEPARATE_BUTTON = 1;
const OPEN_IN_BROWSER_BUTTON = 2;
const QUIT_BUTTON = 3;

export const resolveExistingLocalBackendForStartup: Effect.Effect<
  ExistingLocalBackendStartupSelection,
  ElectronDialog.ElectronDialogShowMessageBoxError,
  | DesktopBackendConfiguration.DesktopBackendConfiguration
  | ElectronDialog.ElectronDialog
  | ElectronShell.ElectronShell
> = Effect.gen(function* () {
  const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const shell = yield* ElectronShell.ElectronShell;

  while (true) {
    const resolution = yield* configuration.resolveExistingLocalBackend;
    if (resolution._tag === "ReadyToAttach") {
      return { _tag: "Continue", attachment: Option.some(resolution.attachment) } as const;
    }
    if (resolution._tag === "Disabled" || resolution._tag === "NotFound") {
      return { _tag: "Continue", attachment: Option.none() } as const;
    }

    yield* Effect.logWarning("could not authenticate with existing local T3 Code backend", {
      origin: resolution.backend.origin,
      baseDir: resolution.backend.baseDir,
      error: resolution.error,
    });
    const result = yield* dialog.showMessageBox({
      type: "warning",
      title: "Running T3 Code server detected",
      message: "Desktop could not connect securely to the T3 Code server already running here.",
      detail: [
        `Server: ${resolution.backend.origin}`,
        "No additional backend has been started.",
        "Try again, open the existing server in your browser, or explicitly start a separate backend for this Desktop launch.",
        "",
        resolution.error.message,
      ].join("\n"),
      buttons: ["Try Again", "Start Separate Backend", "Open in Browser", "Quit"],
      defaultId: TRY_AGAIN_BUTTON,
      cancelId: QUIT_BUTTON,
      noLink: true,
    });

    if (result.response === TRY_AGAIN_BUTTON) continue;
    if (result.response === START_SEPARATE_BUTTON) {
      yield* configuration.useIndependentBackendForLaunch;
      return { _tag: "Continue", attachment: Option.none() } as const;
    }
    if (result.response === OPEN_IN_BROWSER_BUTTON) {
      const opened = yield* shell.openExternal(resolution.backend.origin);
      if (!opened) continue;
    }
    return { _tag: "Quit" } as const;
  }
}).pipe(Effect.withSpan("desktop.existingLocalBackend.resolveForStartup"));
