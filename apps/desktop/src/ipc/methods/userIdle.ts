import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { GET_USER_IDLE_MS_CHANNEL, USER_AWAY_CHANGED_CHANNEL } from "../channels.ts";

// The renderer only sees input aimed at its own window; the OS idle clock also
// covers time spent in other apps, which is still time at this computer.
export const installUserIdle = Effect.fn("desktop.ipc.installUserIdle")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  let suspended = false;
  const announce = () => {
    for (const window of Electron.BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(USER_AWAY_CHANGED_CHANNEL);
    }
  };
  yield* powerMonitor.onSimpleEvent("suspend", () => {
    suspended = true;
    announce();
  });
  yield* powerMonitor.onSimpleEvent("resume", () => {
    suspended = false;
    announce();
  });
  yield* powerMonitor.onSimpleEvent("lock-screen", announce);
  yield* powerMonitor.onSimpleEvent("unlock-screen", announce);
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: GET_USER_IDLE_MS_CHANNEL,
      payload: Schema.Undefined,
      result: Schema.NullOr(Schema.Number),
      handler: Effect.fn("desktop.ipc.getUserIdleMs")(function* () {
        if (suspended || (yield* powerMonitor.getSystemIdleState(1)) === "locked") return null;
        return (yield* powerMonitor.getSystemIdleTime) * 1_000;
      }),
    }),
  );
});
