import { DesktopNotificationTargetSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopNotifications from "../../notifications/DesktopNotifications.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const reportActiveThread = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.REPORT_ACTIVE_THREAD_CHANNEL,
  payload: Schema.NullOr(DesktopNotificationTargetSchema),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.reportActiveThread")(function* (target) {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    yield* notifications.reportActiveThread(Option.fromNullishOr(target));
  }),
});

export const consumeNotificationTarget = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.CONSUME_NOTIFICATION_TARGET_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(DesktopNotificationTargetSchema),
  handler: Effect.fn("desktop.ipc.notifications.consumeTarget")(function* () {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    return Option.getOrNull(yield* notifications.consumePendingTarget);
  }),
});
