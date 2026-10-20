import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopPreReadyFileSystem from "../../app/DesktopPreReadyFileSystem.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
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

export const getHomeEnvironmentId = makeSyncIpcMethod({
  channel: IpcChannels.GET_HOME_ENVIRONMENT_ID_CHANNEL,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.localEnvironment.getHomeEnvironmentId")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    // The server's environment identity file (apps/server/src/config.ts), absent
    // until a server has started on this home. Sync IPC handlers run under
    // Effect.runSync, so the read must not suspend, and must not fail either: a
    // failed sync handler never sets returnValue and leaves the renderer blocked.
    const id = yield* DesktopPreReadyFileSystem.make
      .readFileString(environment.path.join(environment.stateDir, "environment-id"))
      .pipe(
        Effect.map((raw) => raw.trim()),
        Effect.catch((error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed("")
            : Effect.logWarning("Could not read the home environment ID.", { error }).pipe(
                Effect.as(""),
              ),
        ),
      );
    return id.length > 0 ? id : null;
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
