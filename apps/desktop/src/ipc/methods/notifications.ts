import {
  DesktopNotificationShowInputSchema,
  DesktopNotificationShowResultSchema,
  DesktopNotificationTargetSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopNotifications from "../../notifications/DesktopNotifications.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showDesktopNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_NOTIFICATION_SHOW_CHANNEL,
  payload: DesktopNotificationShowInputSchema,
  result: DesktopNotificationShowResultSchema,
  handler: Effect.fn("desktop.ipc.notifications.show")(function* (input) {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    return yield* notifications.show(input);
  }),
});

export const dismissDesktopNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_NOTIFICATION_DISMISS_CHANNEL,
  payload: DesktopNotificationTargetSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.dismiss")(function* (target) {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    yield* notifications.dismiss(target);
  }),
});

export const dismissAllDesktopNotifications = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_NOTIFICATION_DISMISS_ALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.dismissAll")(function* () {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    yield* notifications.dismissAll;
  }),
});

export const showDesktopNotificationTest = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_NOTIFICATION_SHOW_TEST_CHANNEL,
  payload: Schema.Struct({ silent: Schema.Boolean }),
  result: DesktopNotificationShowResultSchema,
  handler: Effect.fn("desktop.ipc.notifications.showTest")(function* (input) {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    return yield* notifications.showTest(input);
  }),
});
