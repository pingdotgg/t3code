import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { GET_USER_IDLE_MS_CHANNEL, USER_AWAY_CHANGED_CHANNEL } from "../channels.ts";

// Input in other apps reaches no renderer, so the OS idle clock decides; sample it
// to tell windows the moment someone comes back, not on their next heartbeat.
const AWAY_SECONDS = 60;

export const installUserPresence = Effect.fn("desktop.ipc.installUserPresence")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  let suspended = false;
  const broadcastAwayChange = () => {
    for (const window of Electron.BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(USER_AWAY_CHANGED_CHANNEL);
    }
  };
  yield* powerMonitor.onSimpleEvent("suspend", () => {
    suspended = true;
    broadcastAwayChange();
  });
  yield* powerMonitor.onSimpleEvent("resume", () => {
    suspended = false;
    broadcastAwayChange();
  });
  yield* powerMonitor.onSimpleEvent("lock-screen", broadcastAwayChange);
  yield* powerMonitor.onSimpleEvent("unlock-screen", broadcastAwayChange);
  let lastIdleSeconds = 0;
  yield* powerMonitor.getSystemIdleTime.pipe(
    Effect.tap((idleSeconds) =>
      Effect.sync(() => {
        if (lastIdleSeconds >= AWAY_SECONDS && idleSeconds < lastIdleSeconds) {
          broadcastAwayChange();
        }
        lastIdleSeconds = idleSeconds;
      }),
    ),
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.forkScoped,
  );
  // Chromium reports 0 forever where it has no idle source (Wayland outside GNOME
  // and KDE), which would read as someone always at the computer. Until the clock
  // moves once, input in the window decides instead.
  let idleClockMoved = false;
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: GET_USER_IDLE_MS_CHANNEL,
      payload: Schema.Undefined,
      result: Schema.NullishOr(Schema.Number),
      handler: Effect.fn("desktop.ipc.getUserIdleMs")(function* () {
        if (suspended || (yield* powerMonitor.getSystemIdleState(1)) === "locked") return null;
        const idleSeconds = yield* powerMonitor.getSystemIdleTime;
        if (idleSeconds > 0) idleClockMoved = true;
        return idleClockMoved ? idleSeconds * 1_000 : undefined;
      }),
    }),
  );
});
