import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { Message, MessageType, Variant } from "dbus-next";

import { openRemoteDesktop, type PortalBus } from "./RemoteDesktopPortal.ts";

const PORTAL_OWNER = ":1.5";
const OWN_NAME = ":1.42";
const REQUEST_PREFIX = "/org/freedesktop/portal/desktop/request/1_42/";
const SESSION_HANDLE = "/org/freedesktop/portal/desktop/session/1_42/s";

type StartAnswer = "allow" | "cancel" | "keyboard-only" | "never";

const streams = [
  [51, { position: new Variant("(ii)", [2560, 0]), size: new Variant("(ii)", [2560, 1440]) }],
  [50, { position: new Variant("(ii)", [0, 0]), size: new Variant("(ii)", [2560, 1440]) }],
];

/** Answers like xdg-desktop-portal, including a Response that beats its method reply. */
const makeFakeBus = (start: StartAnswer) =>
  Effect.gen(function* () {
    const startCalled = yield* Deferred.make<void>();
    const calls: Array<Message> = [];
    const sent: Array<Message> = [];
    const listeners = new Set<(message: Message) => void>();
    let disconnected = false;
    const emit = (path: string, iface: string, member: string, body: Array<unknown>) => {
      const signal = new Message({
        type: MessageType.SIGNAL,
        sender: PORTAL_OWNER,
        path,
        interface: iface,
        member,
        body,
      });
      for (const listener of listeners) listener(signal);
    };
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
                streams: new Variant("a(ua{sv})", streams),
                restore_token: new Variant("s", "restore-2"),
              });
            });
            return reply([handle]);
          default:
            return reply([]);
        }
      },
      send: (message) => sent.push(message),
      onMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onError: () => undefined,
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
      isDisconnected: () => disconnected,
    };
  });

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

  it.effect("completes `closed` when the desktop ends the session", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeBus("allow");
      const session = yield* openRemoteDesktop(fake.bus, options);
      const closed = yield* Effect.forkChild(session.closed);
      fake.emit(
        "/org/freedesktop/portal/desktop/session/1_42/other",
        "org.freedesktop.portal.Session",
        "Closed",
        [],
      );
      fake.emit(SESSION_HANDLE, "org.freedesktop.portal.Session", "Closed", []);
      yield* Fiber.join(closed);
      expect(fake.isDisconnected()).toBe(false);
    }),
  );
});
