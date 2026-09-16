import { DesktopAppActivationResponse, DesktopAppConnectionCompletion } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
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

export class AppConnectionIpcUnauthorizedSenderError extends Schema.TaggedError<AppConnectionIpcUnauthorizedSenderError>()(
  "AppConnectionIpcUnauthorizedSenderError",
  {},
) {
  override get message(): string {
    return "Connection bridge request was rejected.";
  }
}

// Only the main window's renderer may claim connection readiness or answer a
// dispatch; a preview webview or any other web contents is refused.
const ensureTrustedConnectionSender = Effect.fn("desktop.ipc.appActivation.ensureTrustedSender")(
  function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* new AppConnectionIpcUnauthorizedSenderError();
    }
  },
);

export const setConnectionReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_CONNECTION_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.setConnectionReady")(function* (ready, event) {
    yield* ensureTrustedConnectionSender(event);
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.setConnectionRendererReady(ready);
  }),
});

export const completeConnection = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_CONNECTION_COMPLETE_CHANNEL,
  payload: DesktopAppConnectionCompletion,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.completeConnection")(function* (completion, event) {
    yield* ensureTrustedConnectionSender(event);
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.completeConnection(completion);
  }),
});
