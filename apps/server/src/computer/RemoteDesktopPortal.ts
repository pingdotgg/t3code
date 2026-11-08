import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Message, MessageFlag, MessageType, Variant, sessionBus } from "dbus-next";

const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const REMOTE_DESKTOP = "org.freedesktop.portal.RemoteDesktop";
const SCREEN_CAST = "org.freedesktop.portal.ScreenCast";
const REQUEST = "org.freedesktop.portal.Request";
const SESSION = "org.freedesktop.portal.Session";
const DBUS = "org.freedesktop.DBus";
const DBUS_PATH = "/org/freedesktop/DBus";

const DEVICE_KEYBOARD = 1;
const DEVICE_POINTER = 2;
const KEYBOARD_AND_POINTER = DEVICE_KEYBOARD | DEVICE_POINTER;
const SOURCE_MONITOR = 1;
/** The portal keeps the grant until the user revokes it, so a later session can skip the dialog. */
const PERSIST_UNTIL_REVOKED = 2;

const CALL_TIMEOUT = Duration.seconds(10);

/** The slice of a dbus-next connection the portal client uses. */
export interface PortalBus {
  call(message: Message): Promise<Message | null>;
  send(message: Message): void;
  onMessage(listener: (message: Message) => void): () => void;
  onError(listener: () => void): void;
  disconnect(): void;
}

export const connectSessionBus = (): PortalBus => {
  const bus = sessionBus();
  let open = true;
  return {
    call: (message) => bus.call(message),
    send: (message) => bus.send(message),
    onMessage: (listener) => {
      bus.on("message", listener);
      return () => bus.removeListener("message", listener);
    },
    onError: (listener) => bus.on("error", listener),
    disconnect: () => {
      if (!open) return;
      open = false;
      bus.disconnect();
    },
  };
};

export class PortalCallError extends Schema.TaggedError<PortalCallError>()("PortalCallError", {
  member: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Portal call ${this.member} failed.`;
  }
}

/** The user, or the desktop, answered the portal with something other than yes. */
export class PortalConsentError extends Schema.TaggedError<PortalConsentError>()(
  "PortalConsentError",
  { outcome: Schema.Literals(["cancelled", "denied", "timeout"]) },
) {}

export class PortalUnsupportedError extends Schema.TaggedError<PortalUnsupportedError>()(
  "PortalUnsupportedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** A monitor stream, in the desktop's logical coordinates. */
export interface PortalStream {
  readonly nodeId: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RemoteDesktopSession {
  readonly streams: ReadonlyArray<PortalStream>;
  readonly restoreToken: string | null;
  /** Completes when the desktop or the user ends the session, or the bus drops. */
  readonly closed: Effect.Effect<void>;
  /** `x` and `y` are logical coordinates inside `stream`. */
  readonly pointerMotionAbsolute: (
    stream: PortalStream,
    x: number,
    y: number,
  ) => Effect.Effect<void, PortalCallError>;
  /** `button` is an evdev code, such as BTN_LEFT. */
  readonly pointerButton: (
    button: number,
    pressed: boolean,
  ) => Effect.Effect<void, PortalCallError>;
  readonly pointerAxis: (dx: number, dy: number) => Effect.Effect<void, PortalCallError>;
  readonly keyboardKeysym: (
    keysym: number,
    pressed: boolean,
  ) => Effect.Effect<void, PortalCallError>;
  readonly close: Effect.Effect<void>;
}

const isVariant = (value: unknown): value is Variant =>
  typeof value === "object" && value !== null && "signature" in value && "value" in value;

const variantValue = (dict: unknown, key: string): unknown => {
  if (typeof dict !== "object" || dict === null) return undefined;
  const entry = (dict as Record<string, unknown>)[key];
  return isVariant(entry) ? entry.value : undefined;
};

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parsePair = (value: unknown): readonly [number, number] | undefined => {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [first, second] = value.map(asNumber);
  return first === undefined || second === undefined ? undefined : [first, second];
};

/**
 * `streams` from a Start response: `a(ua{sv})` with logical `position` and `size`, or null when
 * any stream lacks either. The spec makes both optional, and a guessed position could line a
 * stream up with a screen the user did not share.
 */
const parseStreams = (value: unknown): ReadonlyArray<PortalStream> | null => {
  if (!Array.isArray(value)) return [];
  const streams: Array<PortalStream> = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const nodeId = asNumber(entry[0]);
    const position = parsePair(variantValue(entry[1], "position"));
    const size = parsePair(variantValue(entry[1], "size"));
    if (nodeId === undefined || position === undefined || size === undefined) return null;
    if (size[0] <= 0 || size[1] <= 0) return null;
    streams.push({ nodeId, x: position[0], y: position[1], width: size[0], height: size[1] });
  }
  return streams;
};

type MessageInit = ConstructorParameters<typeof Message>[0];

const call = (bus: PortalBus, message: MessageInit) => {
  const member = message.member ?? "";
  return Effect.tryPromise({
    try: () => bus.call(new Message(message)),
    catch: (cause) => new PortalCallError({ member, cause }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: CALL_TIMEOUT,
      orElse: () => Effect.fail(new PortalCallError({ member, cause: "timed out" })),
    }),
    Effect.filterOrFail(
      (reply): reply is Message => reply !== null,
      () => new PortalCallError({ member, cause: "no reply" }),
    ),
  );
};

const getProperties = (bus: PortalBus, iface: string) =>
  call(bus, {
    destination: PORTAL,
    path: PORTAL_PATH,
    interface: "org.freedesktop.DBus.Properties",
    member: "GetAll",
    signature: "s",
    body: [iface],
  }).pipe(
    Effect.map((reply): unknown => reply.body[0]),
    Effect.catchTags({
      PortalCallError: () =>
        Effect.fail(
          new PortalUnsupportedError({ reason: "This desktop has no remote desktop portal." }),
        ),
    }),
  );

/** Fails unless the portal can share monitors with keyboard and pointer control. */
const checkRemoteDesktopSupport = Effect.fn("RemoteDesktopPortal.checkSupport")(function* (
  bus: PortalBus,
) {
  const remote = yield* getProperties(bus, REMOTE_DESKTOP);
  const cast = yield* getProperties(bus, SCREEN_CAST);
  const devices = asNumber(variantValue(remote, "AvailableDeviceTypes")) ?? 0;
  const version = asNumber(variantValue(remote, "version")) ?? 0;
  const sources = asNumber(variantValue(cast, "AvailableSourceTypes")) ?? 0;
  if (
    version < 2 ||
    (devices & KEYBOARD_AND_POINTER) !== KEYBOARD_AND_POINTER ||
    (sources & SOURCE_MONITOR) === 0
  ) {
    return yield* new PortalUnsupportedError({
      reason:
        "This desktop's remote desktop portal cannot share the screen with keyboard and pointer control.",
    });
  }
});

export interface OpenRemoteDesktopOptions {
  readonly appId: string;
  /** Host apps register their id so the dialog names them; sandboxed apps already have one. */
  readonly registerAppId: boolean;
  readonly restoreToken: string | null;
  readonly consentTimeout: Duration.Input;
}

/**
 * Opens a RemoteDesktop session with monitor screencast streams. The desktop
 * shows its consent dialog unless `restoreToken` still holds a grant. Pointer
 * motion needs the streams: the portal checks positions against them.
 * Owns `bus` from here on, and disconnects it when the session ends or fails.
 */
export const openRemoteDesktop = Effect.fn("RemoteDesktopPortal.open")(function* (
  bus: PortalBus,
  options: OpenRemoteDesktopOptions,
) {
  const closed = yield* Deferred.make<void>();
  let sessionHandle: string | undefined;
  let portal: string | undefined;
  // Responses can arrive ahead of their method reply, so keep the early ones.
  const responses = new Map<string, ReadonlyArray<unknown>>();
  const waiters = new Map<string, (body: ReadonlyArray<unknown>) => void>();
  const unsubscribe = bus.onMessage((message) => {
    if (message.type !== MessageType.SIGNAL || message.sender !== portal) return;
    if (message.interface === REQUEST && message.member === "Response") {
      const waiter = waiters.get(message.path);
      if (waiter) waiter(message.body);
      else if (responses.size < 16) responses.set(message.path, message.body);
    } else if (
      message.interface === SESSION &&
      message.member === "Closed" &&
      message.path === sessionHandle
    ) {
      Deferred.doneUnsafe(closed, Effect.void);
    }
  });
  bus.onError(() => Deferred.doneUnsafe(closed, Effect.void));

  let ended = false;
  const close = Effect.sync(() => {
    if (ended) return;
    ended = true;
    if (sessionHandle !== undefined && portal !== undefined) {
      bus.send(
        new Message({
          destination: portal,
          path: sessionHandle,
          interface: SESSION,
          member: "Close",
          flags: MessageFlag.NO_REPLY_EXPECTED,
        }),
      );
    }
    unsubscribe();
    bus.disconnect();
    Deferred.doneUnsafe(closed, Effect.void);
  });

  const open = Effect.gen(function* () {
    const owner = yield* call(bus, {
      destination: DBUS,
      path: DBUS_PATH,
      interface: DBUS,
      member: "GetNameOwner",
      signature: "s",
      body: [PORTAL],
    });
    const portalName = asString(owner.body[0]);
    if (portalName === undefined) {
      return yield* new PortalCallError({ member: "GetNameOwner", cause: "invalid owner" });
    }
    portal = portalName;
    const requestNamespace = `${PORTAL_PATH}/request/${owner.destination.slice(1).replaceAll(".", "_")}`;
    let tokens = 0;
    const token = () => `t3_${process.pid}_${++tokens}`;

    const addMatch = (rule: string) =>
      call(bus, {
        destination: DBUS,
        path: DBUS_PATH,
        interface: DBUS,
        member: "AddMatch",
        signature: "s",
        body: [rule],
      });

    const awaitResponse = (handle: string) =>
      Effect.callback<ReadonlyArray<unknown>>((resume) => {
        const early = responses.get(handle);
        if (early) {
          responses.delete(handle);
          resume(Effect.succeed(early));
          return;
        }
        waiters.set(handle, (body) => resume(Effect.succeed(body)));
        return Effect.sync(() => waiters.delete(handle));
      });

    const request = Effect.fn("RemoteDesktopPortal.request")(function* (
      iface: string,
      member: string,
      signature: string,
      body: (handleToken: string) => Array<unknown>,
      timeout: Duration.Input = CALL_TIMEOUT,
    ) {
      const handleToken = token();
      // The portal derives the handle from the token, so a call cut short can still close it.
      let handle = `${requestNamespace}/${handleToken}`;
      const response = yield* Effect.gen(function* () {
        const reply = yield* call(bus, {
          destination: portalName,
          path: PORTAL_PATH,
          interface: iface,
          member,
          signature,
          body: body(handleToken),
        });
        const returned = asString(reply.body[0]);
        if (returned === undefined || !returned.startsWith(`${requestNamespace}/`)) {
          return yield* new PortalCallError({ member, cause: "invalid request handle" });
        }
        handle = returned;
        return yield* awaitResponse(handle).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () => Effect.fail(new PortalConsentError({ outcome: "timeout" })),
          }),
        );
      }).pipe(
        // An unanswered dialog must not outlive its caller.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : Effect.sync(() =>
                bus.send(
                  new Message({
                    destination: portalName,
                    path: handle,
                    interface: REQUEST,
                    member: "Close",
                    flags: MessageFlag.NO_REPLY_EXPECTED,
                  }),
                ),
              ),
        ),
      );
      const code = asNumber(response[0]);
      if (code === 1) return yield* new PortalConsentError({ outcome: "cancelled" });
      if (code !== 0) return yield* new PortalConsentError({ outcome: "denied" });
      return response[1];
    });

    yield* addMatch(
      `type='signal',sender='${portalName}',interface='${REQUEST}',member='Response',path_namespace='${requestNamespace}'`,
    );
    if (options.registerAppId) {
      // Best effort: without it the dialog shows a generic name. It must precede other portal calls.
      yield* call(bus, {
        destination: portalName,
        path: PORTAL_PATH,
        interface: "org.freedesktop.host.portal.Registry",
        member: "Register",
        signature: "sa{sv}",
        body: [options.appId, {}],
      }).pipe(Effect.ignore);
    }
    yield* checkRemoteDesktopSupport(bus);

    const created = yield* request(REMOTE_DESKTOP, "CreateSession", "a{sv}", (handleToken) => [
      {
        handle_token: new Variant("s", handleToken),
        session_handle_token: new Variant("s", token()),
      },
    ]);
    const handle = asString(variantValue(created, "session_handle"));
    if (handle === undefined) {
      return yield* new PortalCallError({ member: "CreateSession", cause: "no session handle" });
    }
    sessionHandle = handle;
    yield* addMatch(
      `type='signal',sender='${portalName}',interface='${SESSION}',member='Closed',path='${handle}'`,
    );
    yield* request(SCREEN_CAST, "SelectSources", "oa{sv}", (handleToken) => [
      handle,
      {
        handle_token: new Variant("s", handleToken),
        types: new Variant("u", SOURCE_MONITOR),
        multiple: new Variant("b", true),
      },
    ]);
    yield* request(REMOTE_DESKTOP, "SelectDevices", "oa{sv}", (handleToken) => [
      handle,
      {
        handle_token: new Variant("s", handleToken),
        types: new Variant("u", KEYBOARD_AND_POINTER),
        persist_mode: new Variant("u", PERSIST_UNTIL_REVOKED),
        ...(options.restoreToken === null
          ? {}
          : { restore_token: new Variant("s", options.restoreToken) }),
      },
    ]);
    const started = yield* request(
      REMOTE_DESKTOP,
      "Start",
      "osa{sv}",
      (handleToken) => [handle, "", { handle_token: new Variant("s", handleToken) }],
      options.consentTimeout,
    );
    const devices = asNumber(variantValue(started, "devices")) ?? 0;
    const streams = parseStreams(variantValue(started, "streams"));
    if (streams === null) {
      return yield* new PortalUnsupportedError({
        reason:
          "The desktop portal shared a screen without saying where it is, so clicks could not be placed on it.",
      });
    }
    if ((devices & KEYBOARD_AND_POINTER) !== KEYBOARD_AND_POINTER || streams.length === 0) {
      // The user turned off keyboard or pointer control, or shared no screen.
      return yield* new PortalConsentError({ outcome: "denied" });
    }

    const notify = (member: string, signature: string, body: ReadonlyArray<unknown>) =>
      call(bus, {
        destination: portalName,
        path: PORTAL_PATH,
        interface: REMOTE_DESKTOP,
        member,
        signature,
        body: [handle, {}, ...body],
      }).pipe(Effect.asVoid);

    const session: RemoteDesktopSession = {
      streams,
      restoreToken: asString(variantValue(started, "restore_token")) ?? null,
      closed: Deferred.await(closed),
      pointerMotionAbsolute: (stream, x, y) =>
        notify("NotifyPointerMotionAbsolute", "oa{sv}udd", [stream.nodeId, x, y]),
      pointerButton: (button, pressed) =>
        notify("NotifyPointerButton", "oa{sv}iu", [button, pressed ? 1 : 0]),
      pointerAxis: (dx, dy) => notify("NotifyPointerAxis", "oa{sv}dd", [dx, dy]),
      keyboardKeysym: (keysym, pressed) =>
        notify("NotifyKeyboardKeysym", "oa{sv}iu", [keysym, pressed ? 1 : 0]),
      close,
    };
    return session;
  });

  return yield* open.pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : close)));
});
