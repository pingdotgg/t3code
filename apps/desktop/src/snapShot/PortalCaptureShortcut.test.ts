// @effect-diagnostics nodeBuiltinImport:off -- Event-driven fake of the portal transport.
import * as NodeEvents from "node:events";
import { DBusError, Message, MessageType, Variant, type MessageBus } from "dbus-next";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { PortalCaptureShortcut, portalShortcutTrigger } from "./PortalCaptureShortcut.ts";

const chord = {
  key: "2",
  modKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: true,
  metaKey: false,
};
const root = "/org/freedesktop/portal/desktop";
const portal = "org.freedesktop.portal.GlobalShortcuts";
const clients: PortalCaptureShortcut[] = [];
type Shortcut = [string, { description?: Variant<string>; trigger_description?: Variant<string> }];

class FakeBus extends NodeEvents.EventEmitter {
  calls: Message[] = [];
  sends: Message[] = [];
  disconnect = vi.fn();
  registryError: Error | undefined;
  version = 2;
  autoBind = true;
  actualLabel = "Ctrl+Shift+2";
  bindStatus = 0;
  session = "";
  requestPath = "";
  boundId = "";
  foreignHandle = false;

  send(message: Message) {
    this.sends.push(message);
  }
  signal(
    iface: string,
    member: string,
    path: string,
    body: unknown[],
    sender = ":1.2",
    signature = "",
  ) {
    this.emit(
      "message",
      new Message({
        type: MessageType.SIGNAL,
        sender,
        interface: iface,
        member,
        path,
        body,
        signature,
      }),
    );
  }
  response(path: string, status: number, results: Record<string, Variant<unknown>>) {
    this.signal("org.freedesktop.portal.Request", "Response", path, [status, results]);
  }
  respondBind(status = this.bindStatus) {
    this.response(this.requestPath, status, {
      shortcuts: new Variant("a(sa{sv})", [
        [
          this.boundId,
          {
            description: new Variant("s", "Capture a window"),
            trigger_description: new Variant("s", this.actualLabel),
          },
        ],
      ]),
    });
  }
  activate(id = this.boundId, session = this.session, sender = ":1.2") {
    this.signal(portal, "Activated", root, [session, id, 1, {}], sender, "osta{sv}");
  }
  async call(message: Message) {
    this.calls.push(message);
    const reply = (body: unknown[] = []) =>
      new Message({
        type: MessageType.METHOD_RETURN,
        replySerial: "1",
        destination: ":1.23",
        body,
      });
    if (message.member === "Register") {
      if (this.registryError) throw this.registryError;
      return reply();
    }
    if (message.member === "GetNameOwner") return reply([":1.2"]);
    if (message.member === "Get") return reply([new Variant("u", this.version)]);
    if (message.member === "AddMatch" || message.member === "ConfigureShortcuts") return reply();
    const options = message.body.at(-1) as Record<string, Variant<string>>;
    const path = `${root}/request/1_23/${options.handle_token!.value}`;
    if (message.member === "CreateSession") {
      this.session = `${root}/session/1_23/${options.session_handle_token!.value}`;
      this.response(path, 0, {
        session_handle: new Variant(
          "s",
          this.foreignHandle ? `${root}/session/9_9/other` : this.session,
        ),
      });
    } else if (message.member === "BindShortcuts") {
      this.boundId = (message.body[1] as Shortcut[])[0]![0];
      this.requestPath = path;
      this.emit("bind");
      if (this.autoBind) this.respondBind();
    } else throw new Error(`Unexpected call: ${message.member}`);
    return reply([path]);
  }
}

function start(bus = new FakeBus(), shortcut = chord, managedByHyprland = false) {
  const capture = vi.fn();
  const changed = vi.fn();
  const client = new PortalCaptureShortcut(
    "com.t3tools.T3Code",
    shortcut,
    capture,
    changed,
    bus as unknown as MessageBus,
    managedByHyprland,
  );
  clients.push(client);
  return { bus, client, capture, changed };
}

afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("accepts Hyprland's action-only binding without claiming the keys are reserved", async () => {
  const bus = new FakeBus();
  bus.actualLabel = "";
  const { client, capture } = start(bus, chord, true);
  await client.ready;
  expect(client.state).toMatchObject({
    shortcutRegistered: false,
    shortcutActionRegistered: true,
    shortcutPending: false,
    shortcutCanRetry: false,
  });
  expect(bus.boundId).toBe("capture-window");
  expect(bus.calls.find((call) => call.member === "BindShortcuts")?.body[1]).toEqual([
    ["capture-window", { description: new Variant("s", "Capture a window") }],
  ]);
  bus.activate("wrong");
  bus.activate(bus.boundId, bus.session, ":1.999");
  expect(capture).not.toHaveBeenCalled();
  bus.activate();
  expect(capture).toHaveBeenCalledOnce();
  await expect(client.configure()).rejects.toThrow("Hyprland config");
  bus.signal(portal, "ShortcutsChanged", root, [bus.session, []]);
  bus.activate();
  expect(capture).toHaveBeenCalledOnce();
  expect(client.state.shortcutActionRegistered).toBe(false);
});

it("keeps the Hyprland action ID stable regardless of a saved key chord", async () => {
  const first = start(new FakeBus(), chord, true);
  const second = start(new FakeBus(), { ...chord, key: "7" }, true);
  await Promise.all([first.client.ready, second.client.ready]);
  expect(first.bus.boundId).toBe(second.bus.boundId);
});

it("does not accept an empty trigger as approval on other desktops", async () => {
  const bus = new FakeBus();
  bus.actualLabel = "";
  const { client, capture } = start(bus);
  await client.ready;
  expect(client.state.shortcutRegistered).toBe(false);
  expect(client.state.shortcutActionRegistered).not.toBe(true);
  bus.activate();
  expect(capture).not.toHaveBeenCalled();
});

it.each([
  ["2", "CTRL+SHIFT+2"],
  ["f12", "CTRL+SHIFT+F12"],
  ["pageup", "CTRL+SHIFT+Page_Up"],
  ["+", "CTRL+SHIFT+plus"],
  ["arrowleft", "CTRL+SHIFT+Left"],
  [" ", "CTRL+SHIFT+space"],
])("encodes %s as an XDG shortcut", (key, expected) => {
  expect(portalShortcutTrigger({ ...chord, key })).toBe(expected);
});
it("normalizes Ctrl/Mod and rejects unsupported keys before requesting access", () => {
  expect(portalShortcutTrigger({ ...chord, ctrlKey: true, metaKey: true })).toBe(
    "CTRL+SHIFT+LOGO+2",
  );
  expect(() => portalShortcutTrigger({ ...chord, key: "unknown-key" })).toThrow("isn't supported");
});

it("does not call submission approval, then reads the actual assigned shortcut", async () => {
  const bus = new FakeBus();
  bus.autoBind = false;
  bus.actualLabel = "Ctrl+Shift+7";
  const binding = NodeEvents.EventEmitter.once(bus, "bind");
  const { client } = start(bus);
  await binding;
  expect(client.state.shortcutRegistered).toBe(false);
  expect(client.state.shortcutPending).toBe(true);
  bus.respondBind();
  await client.ready;
  expect(client.state).toMatchObject({
    shortcutRegistered: true,
    shortcutPending: false,
    shortcutLabel: "Ctrl+Shift+7",
  });
});

it("binds only the requested shortcut with a stable ID across sessions", async () => {
  const first = start();
  await first.client.ready;
  first.client.close();
  const { bus, client, capture } = start();
  await client.ready;
  expect(bus.boundId).toBe(first.bus.boundId);
  const binds = bus.calls.filter((call) => call.member === "BindShortcuts");
  expect(binds).toHaveLength(1);
  expect(binds[0]!.body[1]).toEqual([
    [
      bus.boundId,
      {
        description: new Variant("s", "Capture a window"),
        preferred_trigger: new Variant("s", "CTRL+SHIFT+2"),
      },
    ],
  ]);
  bus.activate();
  expect(capture).toHaveBeenCalledOnce();
  expect(bus.calls[0]?.member).toBe("Register");
});

it("ignores other shortcuts, sessions, and forged activations", async () => {
  const { bus, client, capture } = start();
  await client.ready;
  bus.activate("stale-shortcut");
  bus.activate(bus.boundId, `${root}/session/9_9/other`);
  bus.activate(bus.boundId, bus.session, ":1.999");
  expect(capture).not.toHaveBeenCalled();
  bus.activate();
  expect(capture).toHaveBeenCalledOnce();
});

it("replaces a binding without restarting the application and stops the old callback", async () => {
  const first = start();
  await first.client.ready;
  first.client.close();
  const next = start(new FakeBus(), { ...chord, key: "8" });
  await next.client.ready;
  expect(next.bus.boundId).not.toBe(first.bus.boundId);
  expect(next.bus.calls.find((call) => call.member === "BindShortcuts")?.body[1]).toEqual([
    [
      next.bus.boundId,
      {
        description: new Variant("s", "Capture a window"),
        preferred_trigger: new Variant("s", "CTRL+SHIFT+8"),
      },
    ],
  ]);
  first.bus.activate();
  next.bus.activate();
  expect(first.capture).not.toHaveBeenCalled();
  expect(next.capture).toHaveBeenCalledOnce();
  expect(
    first.bus.sends.some(
      (message) =>
        message.interface === "org.freedesktop.portal.Session" && message.member === "Close",
    ),
  ).toBe(true);
});

it.each([1, 2])(
  "reports denied/cancelled response %s and offers the desktop permissions UI",
  async (status) => {
    const bus = new FakeBus();
    bus.bindStatus = status;
    const { client, capture } = start(bus);
    await client.ready;
    expect(client.state.shortcutRegistered).toBe(false);
    expect(client.state.shortcutPending).toBe(false);
    expect(client.state.shortcutCanRetry).toBe(true);
    expect(client.state.shortcutMessage).toContain("wasn't granted");
    bus.activate();
    expect(capture).not.toHaveBeenCalled();
    await client.configure();
    expect(bus.calls.at(-1)?.member).toBe("ConfigureShortcuts");
  },
);

it("treats a remembered empty binding as unassigned, then observes desktop-side edits", async () => {
  const bus = new FakeBus();
  bus.actualLabel = "";
  const { client, capture } = start(bus);
  await client.ready;
  expect(client.state.shortcutRegistered).toBe(false);
  bus.activate();
  expect(capture).not.toHaveBeenCalled();
  bus.signal(portal, "ShortcutsChanged", root, [
    bus.session,
    [[bus.boundId, { trigger_description: new Variant("s", "Meta+F12") }]],
  ]);
  expect(client.state.shortcutLabel).toBe("Meta+F12");
  expect(client.state.shortcutRegistered).toBe(true);
  bus.activate();
  expect(capture).toHaveBeenCalledOnce();
});

it("guides users to manual desktop settings when the portal cannot open them", async () => {
  const bus = new FakeBus();
  bus.version = 1;
  bus.bindStatus = 1;
  const { client } = start(bus);
  await client.ready;
  expect(client.hasSession).toBe(true);
  expect(client.state.shortcutCanRetry).toBe(false);
  expect(client.state.shortcutMessage).toBe(
    "Shortcut permission wasn't granted. Allow T3 Code in your desktop's shortcut settings.",
  );
  await expect(client.configure()).rejects.toThrow("Open your desktop's shortcut settings");
  expect(bus.calls.some((message) => message.member === "ConfigureShortcuts")).toBe(false);
  client.close();
  expect(client.hasSession).toBe(false);
});

it("captures on older portals without offering an unsupported permission dialog", async () => {
  const bus = new FakeBus();
  bus.version = 1;
  const { client, capture } = start(bus);
  await client.ready;
  expect(client.state).toMatchObject({ shortcutRegistered: true, shortcutCanRetry: false });
  bus.activate();
  expect(capture).toHaveBeenCalledOnce();
  bus.signal(portal, "ShortcutsChanged", root, [bus.session, []]);
  expect(client.state).toMatchObject({
    shortcutRegistered: false,
    shortcutCanRetry: false,
    shortcutMessage: "No shortcut is assigned. Choose one in your desktop's shortcut settings.",
  });
  bus.signal("org.freedesktop.portal.Session", "Closed", bus.session, []);
  expect(client.hasSession).toBe(false);
  expect(client.state.shortcutCanRetry).toBe(true);
});

it("closes an outstanding consent request and ignores its late response", async () => {
  const bus = new FakeBus();
  bus.autoBind = false;
  const binding = NodeEvents.EventEmitter.once(bus, "bind");
  const { client, capture, changed } = start(bus);
  await binding;
  client.close();
  bus.respondBind();
  await client.ready;
  bus.activate();
  expect(capture).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(bus.sends.filter((message) => message.member === "Close")).toHaveLength(2);
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it("bounds unanswered consent and cleans up the pending request", async () => {
  vi.useFakeTimers();
  const bus = new FakeBus();
  bus.autoBind = false;
  const binding = NodeEvents.EventEmitter.once(bus, "bind");
  const { client } = start(bus);
  await binding;
  await vi.advanceTimersByTimeAsync(120_000);
  await client.ready;
  expect(client.state.shortcutPending).toBe(false);
  expect(client.state.shortcutMessage).toContain("timed out");
  expect(bus.disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("handles a disappearing portal without keeping a false registered state", async () => {
  const { bus, client } = start();
  await client.ready;
  bus.signal(
    "org.freedesktop.DBus",
    "NameOwnerChanged",
    "/org/freedesktop/DBus",
    ["org.freedesktop.portal.Desktop", ":1.2", ""],
    "org.freedesktop.DBus",
  );
  expect(client.state.shortcutRegistered).toBe(false);
  expect(client.state.shortcutMessage).toContain("restarted");
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it("accepts old portals without Registry but does not ignore permission denial", async () => {
  const bus = new FakeBus();
  bus.registryError = new DBusError("org.freedesktop.DBus.Error.UnknownMethod", "Old portal");
  const first = start(bus);
  await first.client.ready;
  expect(first.client.state.shortcutRegistered).toBe(true);
  const denied = new FakeBus();
  denied.registryError = new DBusError(
    "org.freedesktop.portal.Error.NotAllowed",
    "App is not allowed",
  );
  const second = start(denied);
  await second.client.ready;
  expect(second.client.state.shortcutRegistered).toBe(false);
  expect(denied.calls.some((call) => call.member === "CreateSession")).toBe(false);
});

it("rejects a foreign session without trying to close someone else's session", async () => {
  const bus = new FakeBus();
  bus.foreignHandle = true;
  const { client } = start(bus);
  await client.ready;
  expect(client.state.shortcutRegistered).toBe(false);
  expect(bus.sends.some((message) => message.path.includes("9_9"))).toBe(false);
});
