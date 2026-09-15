import { DesktopAppActivationResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.setReady")(function* (ready) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.setRendererReady(ready);
  }),
});

export const complete = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL,
  payload: DesktopAppActivationResponse,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.complete")(function* (response) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.complete(response);
  }),
});

/**
 * Read-only liveness probe used by the renderer immediately before and after
 * navigating to an existing thread. It answers from the broker's pending set
 * and never itself activates a window.
 */
export const isRequestActive = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_IS_REQUEST_ACTIVE_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.appActivation.isRequestActive")(function* (requestId) {
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    return activation.isRequestActive(requestId);
  }),
});
