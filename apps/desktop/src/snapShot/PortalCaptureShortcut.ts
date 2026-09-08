// @effect-diagnostics nodeBuiltinImport:off -- Stable shortcut IDs and unique portal request tokens.
// @effect-diagnostics globalTimers:off -- Bounded D-Bus calls and user-consent requests at the native boundary.
import * as NodeCrypto from "node:crypto";
import {
  DBusError,
  Message,
  MessageFlag,
  MessageType,
  Variant,
  sessionBus,
  type MessageBus,
  type MessageLike,
} from "dbus-next";
import * as Schema from "effect/Schema";
import type { SnapShotKeyChord } from "@t3tools/contracts";
import { HYPRLAND_CAPTURE_ACTION, portalShortcutTrigger } from "./linuxCaptureSession.ts";
export { portalShortcutTrigger } from "./linuxCaptureSession.ts";

const PORTAL = "org.freedesktop.portal.Desktop";
const PATH = "/org/freedesktop/portal/desktop";
const SHORTCUTS = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST = "org.freedesktop.portal.Request";
const SESSION = "org.freedesktop.portal.Session";
const DBUS = "org.freedesktop.DBus";
const string = Schema.decodeUnknownSync(Schema.String);
const StringVariant = Schema.Struct({ signature: Schema.Literal("s"), value: Schema.String });
const Shortcuts = Schema.Array(
  Schema.Tuple([
    Schema.String,
    Schema.Struct({
      description: Schema.optional(StringVariant),
      trigger_description: Schema.optional(StringVariant),
    }),
  ]),
);
const decodeShortcuts = Schema.decodeUnknownSync(Shortcuts);
const decodeShortcutsResult = Schema.decodeUnknownSync(
  Schema.Struct({
    shortcuts: Schema.Struct({ signature: Schema.Literal("a(sa{sv})"), value: Shortcuts }),
  }),
);
const decodeSession = Schema.decodeUnknownSync(Schema.Struct({ session_handle: StringVariant }));
const decodeResponse = Schema.decodeUnknownSync(
  Schema.Tuple([Schema.Int, Schema.Record(Schema.String, Schema.Unknown)]),
);
const decodeVersion = Schema.decodeUnknownSync(
  Schema.Struct({
    signature: Schema.Literal("u"),
    value: Schema.Int,
  }),
);

export interface PortalShortcutState {
  readonly shortcutActionRegistered?: boolean;
  readonly shortcutRegistered: boolean;
  readonly shortcutPending: boolean;
  /** Whether retry-shortcut can reopen permissions or start a new session. */
  readonly shortcutCanRetry?: boolean;
  readonly shortcutLabel?: string;
  readonly shortcutMessage: string | null;
}

/** Own the portal session, including consent and release; Electron only reports submission. */
export class PortalCaptureShortcut {
  state: PortalShortcutState = {
    shortcutRegistered: false,
    shortcutPending: true,
    shortcutMessage: "Waiting for shortcut permission. Approve the desktop prompt if one appears.",
  };
  readonly ready: Promise<void>;
  private closed = false;
  private owner = "";
  private namespace = "";
  private session = "";
  private shortcutId = "";
  private version = 0;
  private pending: { path: string; resolve: (body: unknown) => void } | undefined;
  private responses = new Map<string, unknown>();
  private readonly stopped: Promise<never>;
  private rejectStopped!: (reason: Error) => void;
  private readonly onCapture: () => void;
  private readonly onStateChanged: () => void;
  private readonly bus: MessageBus;
  private readonly managedByHyprland: boolean;

  constructor(
    appId: string,
    shortcut: SnapShotKeyChord,
    onCapture: () => void,
    onStateChanged: () => void,
    bus: MessageBus = sessionBus(),
    managedByHyprland = false,
  ) {
    this.onCapture = onCapture;
    this.onStateChanged = onStateChanged;
    this.bus = bus;
    this.managedByHyprland = managedByHyprland;
    if (managedByHyprland)
      this.state = {
        shortcutRegistered: false,
        shortcutPending: true,
        shortcutMessage: "Connecting to Hyprland shortcuts…",
      };
    this.stopped = new Promise((_, reject) => {
      this.rejectStopped = reject;
    });
    void this.stopped.catch(() => undefined);
    bus.on("error", this.failed);
    bus.on("message", this.message);
    this.ready = this.initialize(appId, shortcut).catch(this.failed);
  }

  close = () => {
    if (this.closed) return;
    this.closed = true;
    this.rejectStopped(new Error("Capture shortcut registration closed."));
    try {
      if (this.pending) this.closeObject(this.pending.path, REQUEST);
      if (this.session) this.closeObject(this.session, SESSION);
    } catch {
      // A broken bus is already closing its sessions; local cleanup must still run.
    }
    this.bus.removeListener("message", this.message);
    this.responses.clear();
    this.bus.disconnect();
  };

  /** A previously denied binding is changed by the desktop, not by bypassing its decision. */
  get hasSession() {
    return !this.closed && Boolean(this.session);
  }

  async configure() {
    if (this.managedByHyprland)
      throw new Error("Change the capture binding in your Hyprland config, then save it.");
    if (!this.hasSession || this.version < 2)
      throw new Error(
        "Open your desktop's shortcut settings and allow T3 Code's capture shortcut.",
      );
    await this.call({
      destination: this.owner,
      path: PATH,
      interface: SHORTCUTS,
      member: "ConfigureShortcuts",
      signature: "osa{sv}",
      body: [this.session, "", {}],
    });
  }

  private update(state: PortalShortcutState) {
    if (this.closed) return;
    this.state = {
      shortcutCanRetry: !this.managedByHyprland && (!this.hasSession || this.version >= 2),
      ...state,
    };
    this.onStateChanged();
  }

  private failed = (error: unknown) => {
    if (this.closed) return;
    this.update({
      shortcutRegistered: false,
      shortcutPending: false,
      // This failed session is closing, so retry can register a fresh one.
      shortcutCanRetry: !this.managedByHyprland,
      shortcutMessage: this.managedByHyprland
        ? "Couldn't connect to Hyprland shortcuts. Make sure xdg-desktop-portal-hyprland is running, then restart T3 Code."
        : error instanceof Error
          ? error.message
          : "Could not register the capture shortcut.",
    });
    this.close();
  };

  private async wait<T>(promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        this.stopped,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Shortcut permission request timed out. Try again.")),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(message: MessageLike) {
    if (this.closed) throw new Error("Capture shortcut registration closed.");
    const reply = await this.wait(this.bus.call(new Message(message)));
    if (!reply) throw new Error("Missing shortcut portal reply.");
    return reply;
  }

  private closeObject(path: string, iface: string) {
    this.bus.send(
      new Message({
        destination: this.owner,
        path,
        interface: iface,
        member: "Close",
        flags: MessageFlag.NO_REPLY_EXPECTED,
      }),
    );
  }

  private message = (message: Message) => {
    if (this.closed || message.type !== MessageType.SIGNAL) return;
    if (
      message.sender === "org.freedesktop.DBus" &&
      message.interface === DBUS &&
      message.member === "NameOwnerChanged" &&
      message.body[0] === PORTAL &&
      message.body[1] === this.owner
    ) {
      this.failed(new Error("The desktop shortcut service restarted. Retry the shortcut request."));
      return;
    }
    if (!this.owner || message.sender !== this.owner) return;
    if (
      message.interface === REQUEST &&
      message.member === "Response" &&
      message.path.startsWith(this.namespace)
    ) {
      if (message.path === this.pending?.path) this.pending.resolve(message.body);
      else if (this.responses.size < 8) this.responses.set(message.path, message.body);
      return;
    }
    if (
      this.session &&
      message.path === this.session &&
      message.interface === SESSION &&
      message.member === "Closed"
    ) {
      this.failed(
        new Error("Your desktop closed the capture shortcut. Retry the shortcut request."),
      );
      return;
    }
    if (
      message.path !== PATH ||
      message.interface !== SHORTCUTS ||
      message.body[0] !== this.session
    )
      return;
    if (
      message.member === "Activated" &&
      message.signature === "osta{sv}" &&
      message.body[1] === this.shortcutId &&
      (this.state.shortcutRegistered || this.state.shortcutActionRegistered)
    )
      this.onCapture();
    if (message.member === "ShortcutsChanged") {
      try {
        this.bound(decodeShortcuts(message.body[1]));
      } catch (error) {
        this.failed(error);
      }
    }
  };

  private async request(
    member: string,
    signature: string,
    body: unknown[],
    options: Record<string, Variant<unknown>> = {},
  ) {
    const token = `t3_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const expectedPath = this.namespace + token;
    let resolve!: (body: unknown) => void;
    const response = new Promise<unknown>((done) => {
      resolve = done;
    });
    this.pending = { path: expectedPath, resolve };
    this.responses.clear();
    let completed = false;
    try {
      const reply = await this.call({
        destination: this.owner,
        path: PATH,
        interface: SHORTCUTS,
        member,
        signature: signature + "a{sv}",
        body: [...body, { ...options, handle_token: new Variant("s", token) }],
      });
      const handle = string(reply.body[0]);
      if (!handle.startsWith(this.namespace)) throw new Error("Invalid shortcut request handle.");
      this.pending.path = handle;
      if (this.responses.has(handle)) resolve(this.responses.get(handle));
      const [status, results] = decodeResponse(
        await this.wait(response, member === "BindShortcuts" ? 120_000 : 5_000),
      );
      completed = true;
      if (status !== 0) {
        if (member === "BindShortcuts") {
          this.update({
            shortcutRegistered: false,
            shortcutPending: false,
            shortcutMessage:
              this.version >= 2
                ? "Shortcut permission wasn't granted. Open shortcut permissions to allow it."
                : "Shortcut permission wasn't granted. Allow T3 Code in your desktop's shortcut settings.",
          });
          return undefined;
        }
        throw new Error("Your desktop could not create a capture shortcut session.");
      }
      return results;
    } finally {
      if (!completed && !this.closed && this.pending) this.closeObject(this.pending.path, REQUEST);
      this.pending = undefined;
      this.responses.clear();
    }
  }

  private bound(shortcuts: typeof Shortcuts.Type) {
    const shortcut = shortcuts.find(([id]) => id === this.shortcutId);
    if (this.managedByHyprland) {
      this.update({
        shortcutRegistered: false,
        shortcutActionRegistered: Boolean(shortcut),
        shortcutPending: false,
        shortcutMessage: shortcut
          ? "Managed by Hyprland. Add the binding to your config and save it."
          : "Hyprland did not register the capture action. Check that xdg-desktop-portal-hyprland is running, then restart T3 Code.",
      });
      return;
    }
    const label = shortcut?.[1].trigger_description?.value.trim();
    this.update({
      shortcutRegistered: Boolean(shortcut && label),
      shortcutPending: false,
      ...(label ? { shortcutLabel: label } : {}),
      shortcutMessage: label
        ? `Desktop shortcut: ${label}`
        : this.version >= 2
          ? "No shortcut is assigned. Open shortcut permissions to choose one."
          : "No shortcut is assigned. Choose one in your desktop's shortcut settings.",
    });
  }

  private async initialize(appId: string, shortcut: SnapShotKeyChord) {
    const trigger = portalShortcutTrigger(shortcut);
    if (!process.env.FLATPAK_ID && !process.env.SNAP) {
      await this.call({
        destination: PORTAL,
        path: PATH,
        interface: "org.freedesktop.host.portal.Registry",
        member: "Register",
        signature: "sa{sv}",
        body: [appId, {}],
      }).catch((error: unknown) => {
        if (
          !(
            error instanceof DBusError &&
            ["UnknownMethod", "UnknownInterface"].some(
              (name) => error.type === `${DBUS}.Error.${name}`,
            )
          )
        )
          throw error;
      });
    }
    const owner = await this.call({
      destination: DBUS,
      path: "/org/freedesktop/DBus",
      interface: DBUS,
      member: "GetNameOwner",
      signature: "s",
      body: [PORTAL],
    });
    this.owner = string(owner.body[0]);
    this.namespace = `${PATH}/request/${owner.destination.slice(1).replaceAll(".", "_")}/`;
    const version = await this.call({
      destination: this.owner,
      path: PATH,
      interface: "org.freedesktop.DBus.Properties",
      member: "Get",
      signature: "ss",
      body: [SHORTCUTS, "version"],
    });
    this.version = decodeVersion(version.body[0]).value;
    for (const rule of [
      `type='signal',sender='${this.owner}',path_namespace='${PATH}'`,
      `type='signal',sender='org.freedesktop.DBus',interface='${DBUS}',member='NameOwnerChanged',arg0='${PORTAL}'`,
    ])
      await this.call({
        destination: DBUS,
        path: "/org/freedesktop/DBus",
        interface: DBUS,
        member: "AddMatch",
        signature: "s",
        body: [rule],
      });
    const created = await this.request("CreateSession", "", [], {
      session_handle_token: new Variant(
        "s",
        `t3_capture_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
      ),
    });
    const session = decodeSession(created).session_handle.value;
    const sessionNamespace = this.namespace.replace("/request/", "/session/");
    if (!session.startsWith(sessionNamespace)) throw new Error("Invalid shortcut session handle.");
    this.session = session;
    this.shortcutId = this.managedByHyprland
      ? HYPRLAND_CAPTURE_ACTION
      : `t3-snap-shot-${NodeCrypto.createHash("sha256").update(trigger).digest("hex").slice(0, 16)}`;
    // Every session must bind, even when the desktop remembers this shortcut's approval.
    const bound = await this.request("BindShortcuts", "oa(sa{sv})s", [
      this.session,
      [
        [
          this.shortcutId,
          {
            description: new Variant("s", "Capture a window"),
            ...(!this.managedByHyprland ? { preferred_trigger: new Variant("s", trigger) } : {}),
          },
        ],
      ],
      "",
    ]);
    if (bound) this.bound(decodeShortcutsResult(bound).shortcuts.value);
  }
}
