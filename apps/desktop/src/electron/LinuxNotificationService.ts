import { Message, sessionBus, type MessageBus } from "dbus-next";

const DBUS = "org.freedesktop.DBus";
const NOTIFICATIONS = "org.freedesktop.Notifications";

/**
 * Tracks whether the desktop notification service answers on the session bus. Electron shows
 * notifications through libnotify on its main thread, which blocks until the bus gives up
 * activating a service that never claims its name, so callers must only notify once this has
 * seen the service start.
 */
export function watchLinuxNotificationService(bus: MessageBus = sessionBus()) {
  let available = false;
  let probing = false;
  let closed = false;

  const settle = (started: boolean) => () => {
    available = started;
    probing = false;
  };
  const probe = () => {
    probing = true;
    bus
      .call(
        new Message({
          destination: DBUS,
          path: "/org/freedesktop/DBus",
          interface: DBUS,
          member: "StartServiceByName",
          signature: "su",
          body: [NOTIFICATIONS, 0],
        }),
      )
      .then(settle(true), settle(false));
  };

  bus.on("error", () => undefined);
  probe();

  return {
    available: () => {
      if (!available && !probing && !closed) probe();
      return available;
    },
    stop: () => {
      closed = true;
      bus.disconnect();
    },
  };
}
