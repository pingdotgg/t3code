import { DesktopThreadNotification } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopThreadNotifications from "../../app/DesktopThreadNotifications.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

const isMainSender = Effect.fn("desktop.ipc.threadNotifications.isMainSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
) {
  const windows = yield* ElectronWindow.ElectronWindow;
  const window = yield* windows.main;
  return (
    event !== undefined &&
    Option.isSome(window) &&
    !window.value.isDestroyed() &&
    window.value.webContents.id === event.sender.id
  );
});

export const show = DesktopIpc.makeIpcMethod({
  channel: Channels.SHOW_THREAD_NOTIFICATION_CHANNEL,
  payload: DesktopThreadNotification,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.threadNotifications.show")(function* (input, event) {
    if (!(yield* isMainSender(event))) return false;
    return yield* (yield* DesktopThreadNotifications.DesktopThreadNotifications).show(input);
  }),
});

export const close = DesktopIpc.makeIpcMethod({
  channel: Channels.CLOSE_THREAD_NOTIFICATION_CHANNEL,
  payload: Schema.NullOr(Schema.String.check(Schema.isUUID(4))),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.threadNotifications.close")(function* (id, event) {
    if (!(yield* isMainSender(event))) return;
    yield* (yield* DesktopThreadNotifications.DesktopThreadNotifications).close(id);
  }),
});

export const setReady = DesktopIpc.makeIpcMethod({
  channel: Channels.THREAD_NOTIFICATION_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.threadNotifications.setReady")(function* (ready, event) {
    if (!(yield* isMainSender(event))) return;
    yield* (yield* DesktopThreadNotifications.DesktopThreadNotifications).setRendererReady(ready);
  }),
});
