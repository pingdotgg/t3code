import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopServerOwnership from "../backend/DesktopServerOwnership.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";

const { logInfo: logHomeOwnershipInfo, logWarning: logHomeOwnershipWarning } =
  DesktopObservability.makeComponentLogger("desktop-home-ownership");

/**
 * A T3 home the desktop cannot start a server for: another server owns it,
 * or its ownership record cannot be read.
 */
export type DesktopHomeOwner =
  | Extract<
      DesktopServerOwnership.DesktopServerOwner,
      { readonly _tag: "healthy" | "foreign" | "stranded" }
    >
  | {
      readonly _tag: "unknown";
      readonly recordPath: string;
    };

/**
 * Open the desktop for a T3 home that another server already owns.
 *
 * The desktop does not start a second writer for a home that already has one.
 * It stays open: the way out of this state lives in Settings, and quitting
 * would leave the user unable to reach it, because the next launch would
 * find the same owner and stop again.
 */
export const openDesktopWithExistingOwner = Effect.fn(
  "desktop.homeOwnership.openDesktopWithExistingOwner",
)(function* (input: {
  readonly owner: DesktopHomeOwner;
}): Effect.fn.Return<
  void,
  ElectronDialog.ElectronDialogShowErrorBoxError | DesktopWindow.DesktopWindowError,
  | DesktopAppActivation.DesktopAppActivation
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog
  | Scope.Scope
> {
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const desktopState = yield* DesktopState.DesktopState;
  const appActivation = yield* DesktopAppActivation.DesktopAppActivation;

  const quitting = yield* Ref.get(desktopState.quitting);
  if (!quitting) {
    // The desktop app stays open, so the control socket it exposes to
    // `t3 app` has to be listening too. The socket is the desktop's own
    // control channel in the state directory and does not depend on the
    // local environment, so it can start without a backend behind it. A
    // socket that cannot start is worth a warning, not a dead desktop.
    yield* appActivation.start.pipe(
      Effect.tap(() => logHomeOwnershipInfo("desktop app control socket ready")),
      Effect.catch((error) =>
        logHomeOwnershipWarning("desktop app control socket unavailable", {
          errorTag: error._tag,
        }),
      ),
    );
  }
  const title =
    input.owner._tag === "unknown"
      ? "This T3 home's ownership could not be read"
      : "This T3 home is already in use";
  const content =
    input.owner._tag === "unknown"
      ? `The record that says who owns this T3 home (${input.owner.recordPath}) could not be read, so the desktop cannot tell whether the home is free or which server owns it. The desktop did not start a server for a home it cannot place.\n\nMake sure no T3 Code server is running for this T3 home, then remove that file to let the desktop start its own server, and reopen T3 Code.`
      : input.owner._tag === "healthy"
        ? `A T3 Code server is already running for this T3 home (${input.owner.record.origin}). The desktop did not start a second server for the same home, so it cannot open the local environment.\n\nTo use that server, turn off Settings > Connections > Local environment and add it as a saved environment. To let the desktop run its own server instead, stop that server and reopen T3 Code.`
        : input.owner._tag === "stranded"
          ? `The desktop could not stop the server that owns this T3 home (${input.owner.record.origin}), so it did not start a second server for the same home.\n\nStop that server and reopen T3 Code, or turn off Settings > Connections > Local environment and add a running server as a saved environment.`
          : `Another T3 Code server owns this T3 home and is not responding (${input.owner.record.origin}). The desktop did not start a second server for the same home.\n\nStop that server and reopen T3 Code, or turn off Settings > Connections > Local environment and add a running server as a saved environment.`;
  yield* electronDialog.showErrorBox(title, content);
  if (quitting) {
    return;
  }
  yield* desktopWindow.createMain;
});
