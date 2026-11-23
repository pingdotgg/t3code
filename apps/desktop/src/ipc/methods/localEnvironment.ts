import { DesktopBackgroundServiceStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopBackgroundService from "../../backend/DesktopBackgroundService.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as DesktopTray from "../../window/DesktopTray.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getLocalEnvironmentEnabled = makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.localEnvironment.getEnabled")(function* () {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    return (yield* appSettings.get).localEnvironmentEnabled;
  }),
});

export const setLocalEnvironmentEnabled = makeIpcMethod({
  channel: IpcChannels.SET_LOCAL_ENVIRONMENT_ENABLED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.localEnvironment.setEnabled")(function* (enabled) {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const change = yield* appSettings.setLocalEnvironmentEnabled(enabled);
    if (change.changed) {
      yield* lifecycle.relaunch(`localEnvironmentEnabled=${enabled}`);
    }
  }),
});

// A background service sharing this app's T3 home records its environment ID in the same state dir.
export const getHostEnvironmentId = makeIpcMethod({
  channel: IpcChannels.GET_HOST_ENVIRONMENT_ID_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.localEnvironment.getHostEnvironmentId")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const contents = yield* fileSystem
      .readFileString(environment.path.join(environment.stateDir, "environment-id"))
      .pipe(Effect.orElseSucceed(() => ""));
    return contents.trim() || null;
  }),
});

export const getBackgroundServiceState = makeIpcMethod({
  channel: IpcChannels.GET_BACKGROUND_SERVICE_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackgroundServiceStateSchema,
  handler: Effect.fn("desktop.ipc.localEnvironment.getBackgroundServiceState")(function* () {
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    return yield* backgroundService.status;
  }),
});

const syncTrayIfPresent = Effect.serviceOption(DesktopTray.DesktopTray).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.void,
      onSome: (tray) => tray.sync,
    }),
  ),
);

export const enableBackgroundService = makeIpcMethod({
  channel: IpcChannels.ENABLE_BACKGROUND_SERVICE_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackgroundServiceStateSchema,
  handler: Effect.fn("desktop.ipc.localEnvironment.enableBackgroundService")(function* () {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    yield* appSettings.setBackgroundServiceEnabled(true);
    yield* syncTrayIfPresent;
    return yield* backgroundService.status;
  }),
});

export const disableBackgroundService = makeIpcMethod({
  channel: IpcChannels.DISABLE_BACKGROUND_SERVICE_CHANNEL,
  payload: Schema.Void,
  result: DesktopBackgroundServiceStateSchema,
  handler: Effect.fn("desktop.ipc.localEnvironment.disableBackgroundService")(function* () {
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const backgroundService = yield* DesktopBackgroundService.DesktopBackgroundService;
    yield* appSettings.setBackgroundServiceEnabled(false);
    yield* syncTrayIfPresent;
    return yield* backgroundService.status;
  }),
});
