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
  readonly shortcutCanRetry?: boolean;
  readonly shortcutLabel?: string;
  readonly shortcutMessage: string | null;
}

export class PortalCaptureShortcut {
  state: PortalShortcutState = {
    shortcutRegistered: false,
    shortcutPending: true,
    shortcutMessage: "Waiting for shortcut permission. Approve the desktop prompt if one appears.",
  };
  ready: Promise<void>;
  private closed = false;
  private reconnecting = false;
  private owner = "";
  private namespace = "";
  private session = "";
  private shortcutId = "";
  private version = 0;
  private pending: { path: string; resolve: (body: unknown) => void } | undefined;
  private responses = new Map<string, unknown>();
  private registrations = new Map<string, Promise<void>>();
  private stopped = Promise.withResolvers<never>();
  private readonly onCapture: () => void;
  private readonly onStateChanged: () => void;
  private readonly bus: MessageBus;
  private readonly managedByHyprland: boolean;
  private readonly appId: string;
  private readonly shortcut: SnapShotKeyChord;

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
    this.appId = appId;
    this.shortcut = shortcut;
    if (managedByHyprland)
      this.state = {
        shortcutRegistered: false,
        shortcutPending: true,
        shortcutMessage: "Connecting to Hyprland shortcuts…",
      };
    void this.stopped.promise.catch(() => undefined);
    bus.on("error", this.failed);
    bus.on("message", this.message);
    this.ready = this.subscribe();
    this.register();
  }

  private async subscribe() {
    for (const rule of [
      `type='signal',sender='${PORTAL}',path_namespace='${PATH}'`,
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
  }

  private register() {
    const stopped = this.stopped;
    // Drain the interrupted registration before starting another on this connection.
    this.ready = this.ready
      .then(async () => {
        if (this.closed || stopped !== this.stopped) return;
        await this.initialize(stopped);
        this.assertCurrent(stopped);
        this.reconnecting = false;
      })
      .catch((error) => {
        if (this.closed || stopped !== this.stopped) return;
        if (this.reconnecting && !this.owner) {
          this.update({
            shortcutRegistered: false,
            shortcutPending: false,
            shortcutCanRetry: !this.managedByHyprland,
            shortcutMessage:
              (error instanceof Error ? `${error.message} ` : "") +
              "Waiting for the desktop shortcut service to return.",
          });
          return;
        }
        this.failed(error);
      });
  }

  close = () => {
    if (this.closed) return;
    this.closed = true;
    this.stopped.reject(new Error("Capture shortcut registration closed."));
    this.releaseSession();
    this.bus.removeListener("message", this.message);
    this.bus.disconnect();
  };

  private releaseSession() {
    try {
      if (this.pending) this.closeObject(this.pending.path, REQUEST);
      if (this.session) this.closeObject(this.session, SESSION);
    } catch {
      // A broken bus is already closing its sessions; local cleanup must still run.
    }
    this.session = "";
    this.pending = undefined;
    this.responses.clear();
  }

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
      shortcutCanRetry: !this.managedByHyprland,
      shortcutMessage: this.managedByHyprland
        ? "Couldn't connect to Hyprland shortcuts. Make sure xdg-desktop-portal-hyprland is running, then restart T3 Code."
        : error instanceof Error
          ? error.message
          : "Could not register the capture shortcut.",
    });
    this.close();
  };

  private assertCurrent(stopped: PromiseWithResolvers<never>) {
    if (this.closed) throw new Error("Capture shortcut registration closed.");
    if (stopped !== this.stopped) throw new Error("The desktop shortcut service restarted.");
  }

  private async wait<T>(
    promise: Promise<T>,
    timeoutMs = 5_000,
    stopped = this.stopped,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        promise,
        stopped.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Shortcut permission request timed out. Try again.")),
            timeoutMs,
          );
        }),
      ]);
      this.assertCurrent(stopped);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(message: MessageLike, stopped = this.stopped) {
    this.assertCurrent(stopped);
    const reply = await this.wait(this.bus.call(new Message(message)), 5_000, stopped);
    this.assertCurrent(stopped);
    if (!reply) throw new Error("Missing shortcut portal reply.");
    return reply;
  }

  private closeObject(path: string, iface: string, owner = this.owner) {
    this.bus.send(
      new Message({
        destination: owner,
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
      message.signature === "sss" &&
      message.body[0] === PORTAL &&
      (!this.owner || message.body[1] === this.owner)
    ) {
      const recovering =
        this.reconnecting ||
        this.state.shortcutRegistered ||
        this.state.shortcutActionRegistered === true;
      if (!recovering && this.namespace) {
        this.failed(
          new Error("The desktop shortcut service restarted. Retry the shortcut request."),
        );
        return;
      }
      this.reconnecting = recovering;
      this.stopped.reject(new Error("The desktop shortcut service restarted."));
      this.stopped = Promise.withResolvers<never>();
      void this.stopped.promise.catch(() => undefined);
      // A replaced owner can still be alive. Release its objects before switching owners.
      this.releaseSession();
      this.owner = string(message.body[2]);
      if (recovering)
        this.update({
          shortcutRegistered: false,
          shortcutPending: true,
          shortcutCanRetry: false,
          shortcutMessage: "Reconnecting to the desktop shortcut service…",
        });
      this.register();
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
    options: Record<string, Variant<unknown>>,
    stopped: PromiseWithResolvers<never>,
  ) {
    this.assertCurrent(stopped);
    const owner = this.owner;
    const namespace = this.namespace;
    const token = `t3_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const expectedPath = namespace + token;
    const response = Promise.withResolvers<ReturnType<typeof decodeResponse>>();
    void response.promise.catch(() => undefined);
    const pending = {
      path: expectedPath,
      resolve: (body: unknown) => {
        try {
          const result = decodeResponse(body);
          // Owner changes can arrive before the request continuation consumes this response.
          if (member === "CreateSession" && result[0] === 0) {
            const session = decodeSession(result[1]).session_handle.value;
            if (!session.startsWith(namespace.replace("/request/", "/session/")))
              throw new Error("Invalid shortcut session handle.");
            this.session = session;
          }
          if (member === "BindShortcuts") {
            if (result[0] === 0) this.bound(decodeShortcutsResult(result[1]).shortcuts.value);
            else {
              this.reconnecting = false;
              this.update({
                shortcutRegistered: false,
                shortcutPending: false,
                shortcutMessage:
                  this.version >= 2
                    ? "Shortcut permission wasn't granted. Open shortcut permissions to allow it."
                    : "Shortcut permission wasn't granted. Allow T3 Code in your desktop's shortcut settings.",
              });
            }
          }
          response.resolve(result);
        } catch (error) {
          response.reject(error);
        }
      },
    };
    this.pending = pending;
    this.responses.clear();
    let completed = false;
    try {
      const reply = await this.call(
        {
          destination: owner,
          path: PATH,
          interface: SHORTCUTS,
          member,
          signature: signature + "a{sv}",
          body: [...body, { ...options, handle_token: new Variant("s", token) }],
        },
        stopped,
      );
      this.assertCurrent(stopped);
      const handle = string(reply.body[0]);
      if (!handle.startsWith(namespace)) throw new Error("Invalid shortcut request handle.");
      pending.path = handle;
      if (this.responses.has(handle)) pending.resolve(this.responses.get(handle));
      const [status] = await this.wait(
        response.promise,
        member === "BindShortcuts" ? 120_000 : 5_000,
        stopped,
      );
      this.assertCurrent(stopped);
      completed = true;
      if (status !== 0 && member !== "BindShortcuts")
        throw new Error("Your desktop could not create a capture shortcut session.");
    } finally {
      if (this.pending === pending) {
        if (!completed && !this.closed) this.closeObject(pending.path, REQUEST, owner);
        this.pending = undefined;
        this.responses.clear();
      }
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

  private async initialize(stopped: PromiseWithResolvers<never>) {
    const trigger = portalShortcutTrigger(this.shortcut);
    const ownerRequest = {
      destination: DBUS,
      path: "/org/freedesktop/DBus",
      interface: DBUS,
      member: "GetNameOwner",
      signature: "s",
      body: [PORTAL],
    };
    const owner = await this.call(ownerRequest, stopped).catch(async (error: unknown) => {
      this.assertCurrent(stopped);
      if (!(error instanceof DBusError && error.type === `${DBUS}.Error.NameHasNoOwner`))
        throw error;
      await this.call(
        {
          destination: DBUS,
          path: "/org/freedesktop/DBus",
          interface: DBUS,
          member: "StartServiceByName",
          signature: "su",
          body: [PORTAL, 0],
        },
        stopped,
      );
      this.assertCurrent(stopped);
      return this.call(ownerRequest, stopped);
    });
    this.assertCurrent(stopped);
    this.owner = string(owner.body[0]);
    this.namespace = `${PATH}/request/${owner.destination.slice(1).replaceAll(".", "_")}/`;
    if (!process.env.FLATPAK_ID && !process.env.SNAP) {
      let registration = this.registrations.get(this.owner);
      if (!registration) {
        // Registry permits one registration per connection and portal, even across owner changes.
        registration = this.bus
          .call(
            new Message({
              destination: this.owner,
              path: PATH,
              interface: "org.freedesktop.host.portal.Registry",
              member: "Register",
              signature: "sa{sv}",
              body: [this.appId, {}],
            }),
          )
          .then((reply) => {
            if (!reply) throw new Error("Missing shortcut portal reply.");
          })
          .catch((error: unknown) => {
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
        this.registrations.set(this.owner, registration);
      }
      await this.wait(registration, 5_000, stopped);
      this.assertCurrent(stopped);
    }
    const version = await this.call(
      {
        destination: this.owner,
        path: PATH,
        interface: "org.freedesktop.DBus.Properties",
        member: "Get",
        signature: "ss",
        body: [SHORTCUTS, "version"],
      },
      stopped,
    );
    this.assertCurrent(stopped);
    this.version = decodeVersion(version.body[0]).value;
    await this.request(
      "CreateSession",
      "",
      [],
      {
        session_handle_token: new Variant(
          "s",
          `t3_capture_${NodeCrypto.randomUUID().replaceAll("-", "")}`,
        ),
      },
      stopped,
    );
    this.assertCurrent(stopped);
    this.shortcutId = this.managedByHyprland
      ? HYPRLAND_CAPTURE_ACTION
      : `t3-snap-shot-${NodeCrypto.createHash("sha256").update(trigger).digest("hex").slice(0, 16)}`;
    // Every session must bind, even when the desktop remembers this shortcut's approval.
    await this.request(
      "BindShortcuts",
      "oa(sa{sv})s",
      [
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
      ],
      {},
      stopped,
    );
  }
}
