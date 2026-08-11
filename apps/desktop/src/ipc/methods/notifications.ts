import { DesktopNotificationInputSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronNotifications from "../../electron/ElectronNotifications.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_NOTIFICATION_CHANNEL,
  payload: DesktopNotificationInputSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.show")(function* (input) {
    const notifications = yield* ElectronNotifications.ElectronNotifications;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    // The click arrives from Electron outside any fiber, so capture the
    // context here and run the activation as its own promise.
    const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
    const runPromise = Effect.runPromiseWith(context);

    yield* notifications.show({
      title: input.title,
      body: input.body,
      silent: input.silent,
      onActivate: () => {
        void runPromise(
          Effect.gen(function* () {
            // `currentMainOrFirst`, not `focusedMainOrFirst`: a notification is
            // only clicked when the app is unfocused, so nothing is focused yet.
            const window = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(window)) {
              yield* electronWindow.reveal(window.value);
            }
            yield* electronWindow.sendAll(IpcChannels.NOTIFICATION_ACTIVATED_CHANNEL, {
              threadRef: input.threadRef,
            });
          }),
        );
      },
    });
  }),
});
