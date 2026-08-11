import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";

const { logWarning: logNotificationWarning } = makeComponentLogger("desktop-notifications");

export interface ShowNotificationInput {
  readonly title: string;
  readonly body: string;
  readonly silent: boolean;
  readonly onActivate: () => void;
}

export class ElectronNotifications extends Context.Service<
  ElectronNotifications,
  {
    /**
     * Raises a native OS notification. Never fails: a notification that cannot
     * be shown is a cosmetic loss, and taking the app down over one would be
     * strictly worse than staying quiet.
     */
    readonly show: (input: ShowNotificationInput) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronNotifications") {}

/**
 * Notifications are handed to the OS asynchronously. Dropping the last JS
 * reference before the platform is done with it lets GC collect the object
 * mid-flight, which silently loses the banner (and its click handler) on both
 * macOS and Windows. Entries are released on click or close.
 */
const liveNotifications = new Set<Electron.Notification>();

export const make = ElectronNotifications.of({
  show: (input) =>
    Effect.sync(() => {
      if (!Electron.Notification.isSupported()) {
        return;
      }

      const notification = new Electron.Notification({
        title: input.title,
        body: input.body,
        silent: input.silent,
      });
      liveNotifications.add(notification);

      notification.on("click", () => {
        liveNotifications.delete(notification);
        input.onActivate();
      });
      notification.on("close", () => {
        liveNotifications.delete(notification);
      });

      notification.show();
    }).pipe(
      Effect.catchCause((cause) =>
        logNotificationWarning("Failed to show a native notification.", { cause }),
      ),
    ),
});

export const layer = Layer.succeed(ElectronNotifications, make);
