import { Message, MessageType, sessionBus, type MessageBus } from "dbus-next";

const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const NOTIFICATIONS = "org.freedesktop.Notifications";

/**
 * Tracks whether the desktop notification service answers on the session bus. Electron shows
 * notifications through libnotify on its main thread, which blocks until the bus gives up
 * activating a service that never claims its name, so callers must only notify while this has
 * seen the service running.
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
          path: DBUS_PATH,
          interface: DBUS,
          member: "StartServiceByName",
          signature: "su",
          body: [NOTIFICATIONS, 0],
        }),
      )
      .then(settle(true), settle(false));
  };
  // The next notification would reactivate a daemon that exited, so losing it withdraws
  // availability until a fresh probe sees the service running again.
  const onMessage = (message: Message) => {
    if (
      message.type === MessageType.SIGNAL &&
      message.interface === DBUS &&
      message.member === "NameOwnerChanged" &&
      message.body[0] === NOTIFICATIONS &&
      message.body[2] === ""
    )
      available = false;
  };
  const onError = () => {
    available = false;
  };

  bus.on("error", onError);
  bus.on("message", onMessage);
  bus
    .call(
      new Message({
        destination: DBUS,
        path: DBUS_PATH,
        interface: DBUS,
        member: "AddMatch",
        signature: "s",
        body: [
          `type='signal',sender='${DBUS}',interface='${DBUS}',member='NameOwnerChanged',arg0='${NOTIFICATIONS}'`,
        ],
      }),
    )
    .catch(() => undefined);
  probe();

  return {
    available: () => {
      if (!available && !probing && !closed) probe();
      return available;
    },
    stop: () => {
      closed = true;
      bus.removeListener("message", onMessage);
      bus.disconnect();
    },
  };
}
