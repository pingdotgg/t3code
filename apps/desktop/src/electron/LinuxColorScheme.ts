import { Message, MessageType, Variant, sessionBus, type MessageBus } from "dbus-next";

const PORTAL = "org.freedesktop.portal.Desktop";
const PATH = "/org/freedesktop/portal/desktop";
const SETTINGS = "org.freedesktop.portal.Settings";
const DBUS = "org.freedesktop.DBus";
const NAMESPACE = "org.freedesktop.appearance";
const KEY = "color-scheme";

export type LinuxColorScheme = "dark" | "light" | null;

// The portal reports 1 for prefer-dark, 2 for prefer-light and 0 for no preference. GNOME's
// light mode is 0, and the spec asks apps to use their default then, so only 1 is dark.
// The deprecated Read method nests the value in a second variant.
function decodeColorScheme(value: unknown): LinuxColorScheme {
  let scheme = value;
  while (scheme instanceof Variant) scheme = scheme.value;
  return scheme === 1 ? "dark" : scheme === 0 || scheme === 2 ? "light" : null;
}

const settingsCall = (member: "ReadOne" | "Read") =>
  new Message({
    destination: PORTAL,
    path: PATH,
    interface: SETTINGS,
    member,
    signature: "ss",
    body: [NAMESPACE, KEY],
  });

/**
 * Follows the desktop color scheme through the XDG settings portal. Without a session bus or
 * portal it reports nothing, so Chromium's own resolution stays in charge.
 */
export function watchLinuxColorScheme(
  onChange: (scheme: LinuxColorScheme) => void,
  bus: MessageBus = sessionBus(),
) {
  let closed = false;
  let changed = false;
  const report = (value: unknown) => {
    if (!closed) onChange(decodeColorScheme(value));
  };
  const onMessage = (message: Message) => {
    if (
      message.type !== MessageType.SIGNAL ||
      message.path !== PATH ||
      message.interface !== SETTINGS ||
      message.member !== "SettingChanged"
    )
      return;
    const [namespace, key, value] = message.body;
    if (namespace !== NAMESPACE || key !== KEY) return;
    changed = true;
    report(value);
  };
  const ignore = () => undefined;

  bus.on("error", ignore);
  bus.on("message", onMessage);
  const ready = (async () => {
    await bus.call(
      new Message({
        destination: DBUS,
        path: "/org/freedesktop/DBus",
        interface: DBUS,
        member: "AddMatch",
        signature: "s",
        body: [
          `type='signal',interface='${SETTINGS}',member='SettingChanged',path='${PATH}',arg0='${NAMESPACE}',arg1='${KEY}'`,
        ],
      }),
    );
    // ReadOne needs Settings portal version 2; older portals only offer Read.
    const reply = await bus
      .call(settingsCall("ReadOne"))
      .catch(() => bus.call(settingsCall("Read")));
    // The portal answers reads through its backend asynchronously, so a change signal can
    // overtake this reply; the reply then carries the older value.
    if (reply && !changed) report(reply.body[0]);
  })().catch(ignore);

  return {
    ready,
    stop: () => {
      closed = true;
      bus.removeListener("message", onMessage);
      bus.disconnect();
    },
  };
}
