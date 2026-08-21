import {
  DesktopExistingLocalBackendStateSchema,
  type DesktopExistingLocalBackendState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const readExistingLocalBackendState: Effect.Effect<
  DesktopExistingLocalBackendState,
  never,
  DesktopAppSettings.DesktopAppSettings | DesktopBackendPool.DesktopBackendPool
> = Effect.gen(function* () {
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const settings = yield* appSettings.get;
  const primary = yield* pool.primary;
  const config = yield* primary.currentConfig;
  const attached = Option.match(config, {
    onNone: () => false,
    onSome: (value) => value.manageProcess === false,
  });
  return {
    enabled: settings.attachExistingLocalBackend,
    attached,
    origin: attached
      ? Option.getOrElse(
          Option.map(config, (value) => value.httpBaseUrl.href.replace(/\/$/, "")),
          () => null,
        )
      : null,
    label: null,
  };
});

export const getExistingLocalBackendState = makeIpcMethod({
  channel: IpcChannels.GET_EXISTING_LOCAL_BACKEND_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopExistingLocalBackendStateSchema,
  handler: Effect.fn("desktop.ipc.existingLocalBackend.getState")(function* () {
    return yield* readExistingLocalBackendState;
  }),
});

export const setAttachExistingLocalBackend = makeIpcMethod({
  channel: IpcChannels.SET_ATTACH_EXISTING_LOCAL_BACKEND_CHANNEL,
  payload: Schema.Boolean,
  result: DesktopExistingLocalBackendStateSchema,
  handler: Effect.fn("desktop.ipc.existingLocalBackend.setEnabled")(function* (enabled) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const change = yield* appSettings.setAttachExistingLocalBackend(enabled);
    const state = yield* readExistingLocalBackendState;
    if (change.changed) {
      yield* lifecycle.relaunch(`attachExistingLocalBackend=${enabled}`);
    }
    return state;
  }),
});
