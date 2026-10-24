import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CodexMicroDeviceState,
  CodexMicroLighting,
  type CodexMicroEvent,
} from "@t3tools/contracts";

import { makeCodexMicroDevice } from "../../codexMicro/CodexMicroDevice.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import {
  CODEX_MICRO_EVENT_CHANNEL,
  CODEX_MICRO_GET_STATE_CHANNEL,
  CODEX_MICRO_SET_LIGHTING_CHANNEL,
} from "../channels.ts";

function broadcast(event: CodexMicroEvent): void {
  for (const window of Electron.BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(CODEX_MICRO_EVENT_CHANNEL, event);
  }
}

/** Owns the Codex Micro HID connection for the app's lifetime. */
export const installCodexMicro = Effect.fn("desktop.ipc.installCodexMicro")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const device = yield* makeCodexMicroDevice(broadcast);

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: CODEX_MICRO_GET_STATE_CHANNEL,
      payload: Schema.Void,
      result: CodexMicroDeviceState,
      handler: () => device.getState,
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: CODEX_MICRO_SET_LIGHTING_CHANNEL,
      payload: CodexMicroLighting,
      result: Schema.Void,
      handler: device.setLighting,
    }),
  );
});
