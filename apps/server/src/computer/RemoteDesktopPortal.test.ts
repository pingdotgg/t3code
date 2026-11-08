import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { Message, MessageType, Variant } from "dbus-next";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeNet from "node:net";

import { connectSessionBus, openRemoteDesktop, type PortalBus } from "./RemoteDesktopPortal.ts";

const PORTAL = "org.freedesktop.portal.Desktop";
const PORTAL_OWNER = ":1.5";
const DBUS = "org.freedesktop.DBus";
const OWN_NAME = ":1.42";
const REQUEST_PREFIX = "/org/freedesktop/portal/desktop/request/1_42/";
const SESSION_HANDLE = "/org/freedesktop/portal/desktop/session/1_42/s";

type StartAnswer = "allow" | "cancel" | "keyboard-only" | "never";

const streams = [
  [51, { position: new Variant("(ii)", [2560, 0]), size: new Variant("(ii)", [2560, 1440]) }],
  [50, { position: new Variant("(ii)", [0, 0]), size: new Variant("(ii)", [2560, 1440]) }],
];

interface FakeBusOptions {
  readonly startStreams?: ReadonlyArray<unknown>;
  /** Sends throw, as dbus-next's do once the stream has ended. */
  readonly failSend?: boolean;
  /** Another portal takes over just before the owner lookup's reply arrives. */
  readonly replacedDuringLookup?: boolean;
}

/** Answers like xdg-desktop-portal, including a Response that beats its method reply. */
const makeFakeBus = (start: StartAnswer, fakeOptions: FakeBusOptions = {}) =>
  Effect.gen(function* () {
    const startStreams = fakeOptions.startStreams ?? streams;
    const startCalled = yield* Deferred.make<void>();
    const calls: Array<Message> = [];
    const sent: Array<Message> = [];
    const listeners = new Set<(message: Message) => void>();
    const closeListeners = new Set<() => void>();
    let disconnected = false;
    const emit = (
      path: string,
      iface: string,
      member: string,
      body: Array<unknown>,
      sender = PORTAL_OWNER,
    ) => {
      const signal = new Message({
        type: MessageType.SIGNAL,
        sender,
        path,
        interface: iface,
        member,
        body,
      });
      for (const listener of listeners) listener(signal);
    };
    const ownerChanged = (body: Array<unknown>, sender = DBUS) =>
      emit("/org/freedesktop/DBus", DBUS, "NameOwnerChanged", body, sender);
    const respond = (handle: string, code: number, results: Record<string, Variant>) =>
      emit(handle, "org.freedesktop.portal.Request", "Response", [code, results]);
    const reply = (body: Array<unknown>) =>
      new Message({
        type: MessageType.METHOD_RETURN,
        replySerial: "1",
        destination: OWN_NAME,
        body,
      });

    const bus: PortalBus = {
      call: async (message) => {
        calls.push(message);
        const options = message.body.find(
          (part: unknown): part is Record<string, Variant> =>
            typeof part === "object" && part !== null && "handle_token" in part,
        );
        const handle = options ? REQUEST_PREFIX + String(options.handle_token!.value) : "";
        switch (message.member) {
          case "GetNameOwner":
            if (fakeOptions.replacedDuringLookup) ownerChanged([PORTAL, PORTAL_OWNER, ":1.9"]);
            return reply([PORTAL_OWNER]);
          case "GetAll":
            return reply([
              message.body[0] === "org.freedesktop.portal.RemoteDesktop"
                ? { version: new Variant("u", 2), AvailableDeviceTypes: new Variant("u", 7) }
                : { version: new Variant("u", 5), AvailableSourceTypes: new Variant("u", 7) },
            ]);
          case "CreateSession":
            // The portal may answer before the method reply reaches us.
            respond(handle, 0, { session_handle: new Variant("s", SESSION_HANDLE) });
            return reply([handle]);
          case "SelectSources":
          case "SelectDevices":
            queueMicrotask(() => respond(handle, 0, {}));
            return reply([handle]);
          case "Start":
            Deferred.doneUnsafe(startCalled, Effect.void);
            queueMicrotask(() => {
              if (start === "never") return;
              if (start === "cancel") return respond(handle, 1, {});
              respond(handle, 0, {
                devices: new Variant("u", start === "keyboard-only" ? 1 : 3),
                streams: new Variant("a(ua{sv})", startStreams),
                restore_token: new Variant("s", "restore-2"),
              });
            });
            return reply([handle]);
          default:
            return reply([]);
        }
      },
      send: (message) => {
        sent.push(message);
        if (fakeOptions.failSend) throw new Error("Tried to write a message to a closed stream");
      },
      onMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onClose: (listener) => {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      disconnect: () => {
        disconnected = true;
      },
    };
    return {
      bus,
      calls,
      sent,
      startCalled,
      emit,
      ownerChanged,
      listenerCount: () => listeners.size + closeListeners.size,
      isDisconnected: () => disconnected,
    };
  });

type FakeBus = Effect.Success<ReturnType<typeof makeFakeBus>>;

const options = {
  appId: "com.t3tools.T3Code",
  registerAppId: true,
  restoreToken: "restore-1",
  consentTimeout: "2 minutes",
} as const;

const member = (message: Message) => `${message.interface}.${message.member}`;

describe("RemoteDesktopPortal", () => {
  it.effect("starts a keyboard and pointer session with monitor streams and a restore token", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeBus("allow");
      const session = yield* openRemoteDesktop(fake.bus, options);

      expect(session.streams).toEqual([
        { nodeId: 51, x: 2560, y: 0, width: 2560, height: 1440 },
        { nodeId: 50, x: 0, y: 0, width: 2560, height: 1440 },
      ]);
      expect(session.restoreToken).toBe("restore-2");
      // Registration has to come before any other portal call.
      expect(fake.calls.map((message) => message.member)).toEqual([
        // Watching the portal's owner before looking it up leaves no window to miss a change.
        "AddMatch",
        "GetNameOwner",
        "AddMatch",
        "Register",
        "GetAll",
        "GetAll",
        "CreateSession",
        "AddMatch",
        "SelectSources",
        "SelectDevices",
        "Start",
      ]);
      const selectDevices = fake.calls.find((message) => message.member === "SelectDevices")!;
      expect(selectDevices.body[1]).toMatchObject({
        types: { value: 3 },
        persist_mode: { value: 2 },
        restore_token: { value: "restore-1" },
      });

      yield* session.pointerMotionAbsolute(session.streams[0]!, 10.5, 20);
      const motion = fake.calls.at(-1)!;
      expect(motion.signature).toBe("oa{sv}udd");
      expect(motion.body).toEqual([SESSION_HANDLE, {}, 51, 10.5, 20]);
    }),
  );

  it.effect("reports a declined dialog and closes the session it created", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeBus("cancel");
      const error = yield* Effect.flip(openRemoteDesktop(fake.bus, options));
      expect(error).toMatchObject({ _tag: "PortalConsentError", outcome: "cancelled" });
      expect(fake.sent.map(member)).toEqual(["org.freedesktop.portal.Session.Close"]);
      expect(fake.sent[0]!.path).toBe(SESSION_HANDLE);
      expect(fake.isDisconnected()).toBe(true);
    }),
  );

  it.effect("treats a grant without pointer control as denied", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeBus("keyboard-only");
      const error = yield* Effect.flip(openRemoteDesktop(fake.bus, options));
      expect(error).toMatchObject({ _tag: "PortalConsentError", outcome: "denied" });
      expect(fake.isDisconnected()).toBe(true);
    }),
  );

  it.effect.each([
    ["no position", { size: new Variant("(ii)", [2560, 1440]) }],
    [
      "a malformed position",
      { position: new Variant("(i)", [2560]), size: new Variant("(ii)", [2560, 1440]) },
    ],
  ])("refuses a shared screen with %s rather than guessing where it is", ([, geometry]) =>
    Effect.gen(function* () {
      // Guessing the origin would line this stream up with the unshared screen there.
      const fake = yield* makeFakeBus("allow", { startStreams: [[51, geometry], streams[1]] });
      const error = yield* Effect.flip(openRemoteDesktop(fake.bus, options));
      expect(error).toMatchObject({ _tag: "PortalUnsupportedError" });
      expect(fake.sent.map(member)).toEqual(["org.freedesktop.portal.Session.Close"]);
      expect(fake.isDisconnected()).toBe(true);
    }),
  );

  it.effect("closes the open dialog when the caller gives up or nobody answers", () =>
    Effect.gen(function* () {
      const interrupted = yield* makeFakeBus("never");
      const fiber = yield* Effect.forkChild(openRemoteDesktop(interrupted.bus, options));
      yield* Deferred.await(interrupted.startCalled);
      yield* Fiber.interrupt(fiber);
      expect(interrupted.sent.map(member)).toEqual([
        "org.freedesktop.portal.Request.Close",
        "org.freedesktop.portal.Session.Close",
      ]);
      expect(interrupted.sent[0]!.path.startsWith(REQUEST_PREFIX)).toBe(true);

      const unanswered = yield* makeFakeBus("never");
      const waiting = yield* Effect.forkChild(
        Effect.flip(openRemoteDesktop(unanswered.bus, options)),
      );
      yield* Deferred.await(unanswered.startCalled);
      yield* TestClock.adjust("2 minutes");
      expect(yield* Fiber.join(waiting)).toMatchObject({ outcome: "timeout" });
      expect(unanswered.sent.map(member)).toContain("org.freedesktop.portal.Request.Close");
    }),
  );

  it.effect.each([
    [
      "the desktop ends the session",
      (fake: FakeBus) => fake.emit(SESSION_HANDLE, "org.freedesktop.portal.Session", "Closed", []),
    ],
    ["the portal exits", (fake: FakeBus) => fake.ownerChanged([PORTAL, PORTAL_OWNER, ""])],
    [
      "another portal replaces it",
      (fake: FakeBus) => fake.ownerChanged([PORTAL, PORTAL_OWNER, ":1.9"]),
    ],
  ] as const)("completes `closed` when %s", ([, end]) =>
    Effect.gen(function* () {
      const fake = yield* makeFakeBus("allow");
      const session = yield* openRemoteDesktop(fake.bus, options);
      fake.emit(
        "/org/freedesktop/portal/desktop/session/1_42/other",
        "org.freedesktop.portal.Session",
        "Closed",
        [],
      );
      // Only the bus daemon speaks for name owners, and only about the portal's own owner.
      fake.ownerChanged([PORTAL, PORTAL_OWNER, ""], ":1.66");
      fake.ownerChanged(["org.example.Other", PORTAL_OWNER, ""]);
      fake.ownerChanged([PORTAL, ":1.7", ""]);
      fake.ownerChanged([PORTAL, 5]);
      expect(yield* session.isClosed).toBe(false);
      end(fake);
      expect(yield* session.isClosed).toBe(true);
      expect(fake.isDisconnected()).toBe(false);
    }),
  );

  it.effect.each(["its owner is looked up", "the dialog is open"] as const)(
    "gives up on a portal that is replaced while %s",
    (moment) =>
      Effect.gen(function* () {
        const fake = yield* makeFakeBus("never", {
          replacedDuringLookup: moment === "its owner is looked up",
        });
        const opening = yield* Effect.forkChild(Effect.flip(openRemoteDesktop(fake.bus, options)));
        if (moment === "the dialog is open") {
          yield* Deferred.await(fake.startCalled);
          fake.ownerChanged([PORTAL, PORTAL_OWNER, ":1.9"]);
        }
        expect(yield* Fiber.join(opening)).toMatchObject({ _tag: "PortalCallError" });
        const members = fake.calls.map((message) => message.member);
        expect(members.includes("CreateSession")).toBe(moment === "the dialog is open");
        expect(fake.isDisconnected()).toBe(true);
      }),
  );

  it.effect("tears down locally even when the bus can no longer send", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeBus("allow", { failSend: true });
      const session = yield* openRemoteDesktop(fake.bus, options);
      yield* session.close;
      yield* session.close;
      expect(yield* session.isClosed).toBe(true);
      expect(fake.sent.map(member)).toEqual(["org.freedesktop.portal.Session.Close"]);
      expect(fake.listenerCount()).toBe(0);
      expect(fake.isDisconnected()).toBe(true);

      const dialog = yield* makeFakeBus("never", { failSend: true });
      const fiber = yield* Effect.forkChild(openRemoteDesktop(dialog.bus, options));
      yield* Deferred.await(dialog.startCalled);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(dialog.sent.map(member)).toEqual([
        "org.freedesktop.portal.Request.Close",
        "org.freedesktop.portal.Session.Close",
      ]);
      expect(dialog.listenerCount()).toBe(0);
      expect(dialog.isDisconnected()).toBe(true);
    }),
  );
});

describe("connectSessionBus", () => {
  // A stand-in bus daemon that accepts the client, then closes the connection cleanly.
  it.live("reports a connection the daemon ends without an error", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-dbus-" });
      const socketPath = path.join(directory, "bus");
      const server = NodeNet.createServer((socket) => {
        let received = "";
        socket.on("data", (chunk) => {
          received += chunk.toString("latin1");
          if (received.includes("AUTH ") && !received.includes("OK-sent")) {
            received += "OK-sent";
            socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
          }
          if (received.includes("BEGIN\r\n")) socket.end();
        });
      });
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          server.listen(socketPath, () => resume(Effect.void));
        }),
        () => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
      );
      const bus = connectSessionBus(`unix:path=${socketPath}`);
      const closed = yield* Deferred.make<void>();
      bus.onClose(() => Deferred.doneUnsafe(closed, Effect.void));
      yield* Deferred.await(closed);
      bus.disconnect();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
