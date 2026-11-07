import * as Effect from "effect/Effect";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopLifecycle from "./DesktopLifecycle.ts";

export const recover = Effect.fn("desktop.homeRecovery.recover")(function* () {
  const dialog = yield* ElectronDialog.ElectronDialog;
  const app = yield* ElectronApp.ElectronApp;
  const choice = yield* dialog
    .showMessageBox({
      type: "warning",
      title: "This T3 home is unavailable",
      message: "T3 Code cannot start its local environment in this T3 home.",
      detail:
        "Another server owns this home, or an older background service is configured. To use an existing server, disable this app's local environment and restart. Then connect to the server in Settings > Environments using a pairing link from `t3 pair`. The running server and your projects and threads are left intact. You can turn the local environment back on in Settings after stopping the other server.\n\nIf an older background service is still configured, update it with `t3 update`, or remove it with `t3 service uninstall`. Use `npx t3@latest` if the CLI is outdated and pass `--base-dir` with the service's T3 home to each command. Updating a service does not allow two servers to use the same T3 home.",
      buttons: ["Quit", "Disable local environment and restart"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    .pipe(Effect.orElseSucceed(() => ({ response: 0 })));
  if (choice.response !== 1) {
    yield* app.quit;
    return;
  }
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const saved = yield* settings.setLocalEnvironmentEnabled(false).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      dialog
        .showErrorBox("Could not disable the local environment", error.message)
        .pipe(Effect.as(false)),
    ),
  );
  if (!saved) {
    yield* app.quit;
    return;
  }
  const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
  yield* lifecycle.relaunch("localEnvironmentEnabled=false");
});
