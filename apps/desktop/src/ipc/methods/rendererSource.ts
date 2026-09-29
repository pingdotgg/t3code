import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopAppSettings from "../../settings/DesktopAppSettings.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

export const getLocalRendererUrl = makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_RENDERER_URL_CHANNEL,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.rendererSource.get")(function* () {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return (yield* settings.get).localRendererUrl;
  }),
});

export const getLastLocalRendererUrl = makeSyncIpcMethod({
  channel: IpcChannels.GET_LAST_LOCAL_RENDERER_URL_CHANNEL,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.rendererSource.getLast")(function* () {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return (yield* settings.get).lastLocalRendererUrl;
  }),
});

export const setLocalRendererUrl = makeIpcMethod({
  channel: IpcChannels.SET_LOCAL_RENDERER_URL_CHANNEL,
  payload: Schema.NullOr(Schema.String),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.rendererSource.set")(function* (url) {
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    const change = yield* settings.setLocalRendererUrl(url);
    if (change.changed) {
      yield* lifecycle.relaunch(`localRendererUrl=${url === null ? "bundled" : "local"}`);
    }
  }),
});
