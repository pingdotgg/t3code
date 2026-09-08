// @effect-diagnostics globalTimers:off -- D-Bus deadlines run at a native async boundary.
// @effect-diagnostics nodeBuiltinImport:off -- Read the portal file through one bounded file descriptor at the native adapter boundary.

import * as NodeCrypto from "node:crypto";
import {
  DBusError,
  Message,
  MessageFlag,
  MessageType,
  NameFlag,
  RequestNameReply,
  Variant,
  sessionBus,
  type MessageBus,
  type MessageLike,
} from "dbus-next";
import * as Schema from "effect/Schema";
import { isKdeCaptureSession, type KdeCapturePaths } from "./KdeSnapShot.ts";
import { isGnomeCaptureSession, readPortalPng, resizeLinuxCapture } from "./linuxCaptureSession.ts";
export { readPortalPng, resizeLinuxCapture } from "./linuxCaptureSession.ts";
import { isHyprlandCaptureSession, type HyprlandCapturePaths } from "./HyprlandSnapShot.ts";

const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SCREENSHOT = "org.freedesktop.portal.Screenshot";
const REQUEST = "org.freedesktop.portal.Request";
const EXTENSION = "org.gnome.Shell.Extensions.T3SnapShot";
const EXTENSION_PATH = "/org/gnome/Shell/Extensions/T3SnapShot";
const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";
const UInt = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 0xffff_ffff }));
const UIntVariant = Schema.Struct({ signature: Schema.Literal("u"), value: UInt });
const StringVariant = Schema.Struct({ signature: Schema.Literal("s"), value: Schema.String });
const PortalProperties = Schema.Struct({
  version: UIntVariant,
  AvailableTargets: Schema.optional(UIntVariant),
});
const WindowMetadata = Schema.Struct({
  title: Schema.String,
  appName: Schema.String,
  appIdentifier: Schema.String,
  processId: UInt,
  bounds: Schema.Struct({
    x: Schema.Int,
    y: Schema.Int,
    width: Schema.Int.check(Schema.isGreaterThan(0)),
    height: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
});
export type LinuxWindowMetadata = typeof WindowMetadata.Type & {
  readonly clientBounds?: typeof WindowMetadata.Type.bounds;
  readonly accessibilityBoundsReliable?: boolean;
};
const decodeProperties = Schema.decodeUnknownSync(PortalProperties);
const decodeExtension = Schema.decodeUnknownSync(Schema.Struct({ Version: UIntVariant }));
const decodeKde = Schema.decodeUnknownSync(Schema.Struct({ Version: UIntVariant }));
const decodeString = Schema.decodeUnknownSync(Schema.String);
const decodeBoolean = Schema.decodeUnknownSync(Schema.Boolean);
const decodeResponse = Schema.decodeUnknownSync(
  Schema.Tuple([UInt, Schema.Record(Schema.String, Schema.Unknown)]),
);
const decodeUri = Schema.decodeUnknownSync(StringVariant);
const decodeWindow = Schema.decodeUnknownSync(Schema.fromJsonString(WindowMetadata));
export type LinuxCaptureBackend =
  | "screenshot-portal"
  | "gnome-extension"
  | "niri"
  | "kde"
  | "hyprland"
  | "picker";
export type LinuxWindowSnapshot = {
  readonly png: Buffer;
  readonly window?: LinuxWindowMetadata;
  readonly feedback?: LinuxCaptureFeedback;
};

export type LinuxCaptureFeedback = {
  readonly animationStarted: boolean;
  readonly activate: (title: string) => Promise<void>;
  readonly animateTo: (frame: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => Promise<void>;
  readonly complete: () => Promise<void>;
  readonly close: () => void;
};
type FeedbackOptions = { readonly flash: boolean; readonly animate: boolean };

function unavailable(error: unknown): boolean {
  return (
    error instanceof DBusError &&
    ["ServiceUnknown", "NameHasNoOwner", "UnknownObject", "UnknownInterface", "UnknownMethod"].some(
      (name) => error.type === `${DBUS}.Error.${name}`,
    )
  );
}

/** One connection per operation: portal registration and request ownership stay together. */
export class LinuxCaptureConnection {
  private readonly bus: MessageBus;
  private readonly disconnected: Promise<never>;
  private uniqueName = "";
  private extensionVersion = 0;
  private closed = false;
  private feedbackTimer: ReturnType<typeof setTimeout> | undefined;

  get feedbackAvailable() {
    return this.extensionVersion === 2;
  }

  constructor(bus = sessionBus()) {
    this.bus = bus;
    this.disconnected = new Promise((_, reject) => {
      bus.on("error", reject);
    });
    // A disconnect between calls must not become an unhandled rejection.
    void this.disconnected.catch(() => undefined);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.feedbackTimer);
    this.bus.disconnect();
  }

  private async wait<T>(pending: Promise<T>, timeoutMs = 5_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        this.disconnected,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Snapshot timed out.")), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async call(message: MessageLike) {
    const reply = await this.wait(this.bus.call(new Message(message)));
    if (!reply) throw new Error("Missing D-Bus reply.");
    this.uniqueName = reply.destination;
    return reply;
  }

  private async properties(destination: string, path: string, iface: string) {
    const reply = await this.call({
      destination,
      path,
      interface: "org.freedesktop.DBus.Properties",
      member: "GetAll",
      signature: "s",
      body: [iface],
    });
    return reply.body[0] as unknown;
  }

  async backend(appId: string): Promise<LinuxCaptureBackend> {
    if (isKdeCaptureSession()) {
      const kde = await this.properties(
        "org.kde.KWin.ScreenShot2",
        "/org/kde/KWin/ScreenShot2",
        "org.kde.KWin.ScreenShot2",
      ).catch((error: unknown) => {
        if (!unavailable(error)) throw error;
        return undefined;
      });
      if (kde !== undefined && decodeKde(kde).Version.value >= 2) return "kde";
    }
    // Sandboxed apps already have an identity. Host apps register before any portal calls.
    if (!process.env.FLATPAK_ID && !process.env.SNAP) {
      await this.call({
        destination: PORTAL,
        path: PORTAL_PATH,
        interface: "org.freedesktop.host.portal.Registry",
        member: "Register",
        signature: "sa{sv}",
        body: [appId, {}],
      }).catch((error: unknown) => {
        if (!unavailable(error)) throw error;
      });
    }
    const properties = await this.properties(PORTAL, PORTAL_PATH, SCREENSHOT).catch(
      (error: unknown) => {
        if (!unavailable(error)) throw error;
        return undefined;
      },
    );
    if (properties !== undefined) {
      const parsed = decodeProperties(properties);
      if (parsed.version.value >= 3 && ((parsed.AvailableTargets?.value ?? 0) & 8) !== 0) {
        return "screenshot-portal";
      }
    }
    if (!isGnomeCaptureSession(process.env)) return "picker";
    const extension = await this.properties(EXTENSION, EXTENSION_PATH, EXTENSION).catch(
      (error: unknown) => {
        if (!unavailable(error)) throw error;
        return undefined;
      },
    );
    if (extension !== undefined) {
      const parsed = decodeExtension(extension);
      this.extensionVersion = parsed.Version.value;
      if (this.extensionVersion === 1 || this.extensionVersion === 2) return "gnome-extension";
    }
    return "picker";
  }

  async capturePortal(): Promise<LinuxWindowSnapshot> {
    const owner = await this.call({
      destination: DBUS,
      path: DBUS_PATH,
      interface: DBUS,
      member: "GetNameOwner",
      signature: "s",
      body: [PORTAL],
    });
    const sender = decodeString(owner.body[0]);
    const token = `t3_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const namespace = `${PORTAL_PATH}/request/${this.uniqueName.slice(1).replaceAll(".", "_")}/`;
    let handle = namespace + token;
    let completed = false;
    // Subscribe before Screenshot: the response may precede its method reply.
    const responses = new Map<string, unknown>();
    let deliver: ((body: unknown) => void) | undefined;
    const listener = (message: Message) => {
      if (
        message.type !== MessageType.SIGNAL ||
        message.sender !== sender ||
        message.interface !== REQUEST ||
        message.member !== "Response" ||
        !message.path.startsWith(namespace)
      )
        return;
      if (deliver && message.path === handle) deliver(message.body);
      else if (responses.size < 8) responses.set(message.path, message.body);
    };
    this.bus.on("message", listener);
    try {
      await this.call({
        destination: DBUS,
        path: DBUS_PATH,
        interface: DBUS,
        member: "AddMatch",
        signature: "s",
        body: [
          `type='signal',sender='${sender}',interface='${REQUEST}',member='Response',path_namespace='${namespace.slice(0, -1)}'`,
        ],
      });
      const reply = await this.call({
        destination: sender,
        path: PORTAL_PATH,
        interface: SCREENSHOT,
        member: "Screenshot",
        signature: "sa{sv}",
        body: [
          "",
          {
            handle_token: new Variant("s", token),
            interactive: new Variant("b", false),
            modal: new Variant("b", false),
            target: new Variant("u", 8),
          },
        ],
      });
      handle = decodeString(reply.body[0]);
      if (!handle.startsWith(namespace)) throw new Error("Invalid screenshot request handle.");
      const body = await this.wait(
        new Promise<unknown>((resolve) => {
          deliver = resolve;
          if (responses.has(handle)) resolve(responses.get(handle));
        }),
        120_000,
      );
      const [status, results] = decodeResponse(body);
      completed = true;
      if (status === 1) throw new Error("Snapshot was cancelled.");
      if (status !== 0) throw new Error("Your desktop did not allow the snapshot.");
      const uri = decodeUri(results.uri).value;
      return { png: await readPortalPng(uri) };
    } finally {
      this.bus.removeListener("message", listener);
      if (!completed) {
        this.bus.send(
          new Message({
            destination: sender,
            path: handle,
            interface: REQUEST,
            member: "Close",
            flags: MessageFlag.NO_REPLY_EXPECTED,
          }),
        );
      }
      // Closing this dedicated connection also removes the signal match.
    }
  }

  async captureExtension(appId: string, options?: FeedbackOptions): Promise<LinuxWindowSnapshot> {
    const result = await this.wait(
      this.bus.requestName(`${appId}.SnapShot`, NameFlag.DO_NOT_QUEUE),
    );
    if (result !== RequestNameReply.PRIMARY_OWNER) {
      throw new Error("Another T3 Code instance is capturing a window. Try again.");
    }
    const withFeedback = this.feedbackAvailable && options !== undefined;
    const reply = await this.call({
      destination: EXTENSION,
      path: EXTENSION_PATH,
      interface: EXTENSION,
      member: withFeedback ? "CaptureWithFeedback" : "Capture",
      ...(withFeedback ? { signature: "bb", body: [options.flash, options.animate] } : {}),
    });
    const bytes: unknown = reply.body[0];
    if (!(bytes instanceof Uint8Array)) throw new Error("Invalid extension screenshot.");
    const window = decodeWindow(reply.body[1]);
    const png = resizeLinuxCapture(Buffer.from(bytes));
    if (!withFeedback) return { png, window };
    const animationStarted = decodeBoolean(reply.body[2]);
    // Keep the same authenticated sender alive through activation and the compositor flight.
    this.feedbackTimer = setTimeout(() => this.close(), 15_000);
    let flight: Promise<void> | undefined;
    const feedback: LinuxCaptureFeedback = {
      animationStarted,
      activate: async (title) => {
        await this.feedbackCall("Activate", "s", [title]);
      },
      animateTo: (frame) => {
        flight ??= this.feedbackCall("Animate", "dddd", [
          frame.x,
          frame.y,
          frame.width,
          frame.height,
        ]);
        return flight;
      },
      complete: async () => {
        try {
          await flight;
        } finally {
          this.close();
        }
      },
      close: () => this.close(),
    };
    return { png, window, feedback };
  }

  private async feedbackCall(member: string, signature: string, body: unknown[]): Promise<void> {
    if (this.closed) return;
    await this.call({
      destination: EXTENSION,
      path: EXTENSION_PATH,
      interface: EXTENSION,
      member,
      signature,
      body,
    });
  }
}

export async function getLinuxCaptureSupport(appId: string) {
  if (isHyprlandCaptureSession())
    return { linuxBackend: "hyprland" as const, linuxFeedbackAvailable: false };
  const { niriSocketPath, checkNiriCaptureSupport } = await import("./NiriSnapShot.ts");
  const niri = niriSocketPath();
  if (niri) {
    await checkNiriCaptureSupport(niri);
    return { linuxBackend: "niri" as const, linuxFeedbackAvailable: false };
  }
  const connection = new LinuxCaptureConnection();
  try {
    const linuxBackend = await connection.backend(appId);
    return { linuxBackend, linuxFeedbackAvailable: connection.feedbackAvailable };
  } finally {
    connection.close();
  }
}

/** Undefined means capability missing, not denied: only that case may open the picker. */
export async function captureLinuxWindow(
  appId: string,
  options?: FeedbackOptions,
  kdePaths?: KdeCapturePaths,
  hyprlandPaths?: HyprlandCapturePaths,
): Promise<LinuxWindowSnapshot | undefined> {
  if (isHyprlandCaptureSession()) {
    if (!hyprlandPaths) throw new Error("Hyprland capture setup is unavailable in this build.");
    const { captureHyprlandWindow } = await import("./HyprlandSnapShot.ts");
    return captureHyprlandWindow(hyprlandPaths, options);
  }
  const { niriSocketPath, captureNiriWindow } = await import("./NiriSnapShot.ts");
  const niri = niriSocketPath();
  if (niri) return captureNiriWindow(niri);
  const connection = new LinuxCaptureConnection();
  let retained = false;
  try {
    switch (await connection.backend(appId)) {
      case "kde": {
        if (!kdePaths) throw new Error("KDE capture setup is unavailable in this build.");
        const { captureKdeWindow } = await import("./KdeSnapShot.ts");
        return await captureKdeWindow(kdePaths, options);
      }
      case "screenshot-portal":
        return await connection.capturePortal();
      case "gnome-extension": {
        const snapshot = await connection.captureExtension(appId, options);
        retained = snapshot.feedback !== undefined;
        return snapshot;
      }
      case "picker":
        return undefined;
    }
  } finally {
    if (!retained) connection.close();
  }
}
