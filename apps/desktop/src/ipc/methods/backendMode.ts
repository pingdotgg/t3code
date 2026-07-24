import {
  DesktopBackendModeSchema,
  DesktopBackendModeStateSchema,
  type DesktopBackendModeState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopBackendMode from "../../app/DesktopBackendMode.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as IpcChannels from "../channels.ts";

const readBackendModeState: Effect.Effect<
  DesktopBackendModeState,
  never,
  DesktopBackendMode.DesktopBackendMode | DesktopAppSettings.DesktopAppSettings
> = Effect.gen(function* () {
  const launchMode = yield* DesktopBackendMode.DesktopBackendMode;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const launchState = yield* launchMode.get;
  const configuredMode = (yield* settings.get).backendMode;
  return {
    ...launchState,
    configuredMode,
  };
});

export const getBackendModeState = DesktopIpc.makeSyncIpcMethod({
  channel: IpcChannels.GET_BACKEND_MODE_STATE_CHANNEL,
  result: DesktopBackendModeStateSchema,
  handler: Effect.fn("desktop.ipc.backendMode.get")(function* () {
    return yield* readBackendModeState;
  }),
});

export const setBackendMode = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SET_BACKEND_MODE_CHANNEL,
  payload: DesktopBackendModeSchema,
  result: DesktopBackendModeStateSchema,
  handler: Effect.fn("desktop.ipc.backendMode.set")(function* (mode) {
    const launchMode = yield* DesktopBackendMode.DesktopBackendMode;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const change = yield* settings.setBackendMode(mode);
    const launchState = yield* launchMode.get;
    const state = {
      ...launchState,
      configuredMode: change.settings.backendMode,
    };
    if (
      change.changed &&
      launchState.cliOverride === null &&
      launchState.effectiveMode !== change.settings.backendMode
    ) {
      yield* lifecycle.relaunch(`backendMode=${mode}`);
    }
    return state;
  }),
});
