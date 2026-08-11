import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const { isSupportedMock, showMock, notificationConstructorMock, handlersByEvent } = vi.hoisted(
  () => ({
    isSupportedMock: vi.fn(),
    showMock: vi.fn(),
    notificationConstructorMock: vi.fn(),
    handlersByEvent: new Map<string, () => void>(),
  }),
);

vi.mock("electron", () => {
  class Notification {
    static isSupported = isSupportedMock;

    constructor(options: unknown) {
      notificationConstructorMock(options);
    }

    on(event: string, handler: () => void) {
      handlersByEvent.set(event, handler);
      return this;
    }

    show() {
      showMock();
    }
  }

  return { Notification };
});

import * as ElectronNotifications from "./ElectronNotifications.ts";

describe("ElectronNotifications", () => {
  beforeEach(() => {
    isSupportedMock.mockReset();
    showMock.mockReset();
    notificationConstructorMock.mockReset();
    handlersByEvent.clear();
    isSupportedMock.mockReturnValue(true);
  });

  it.effect("shows a notification with the requested copy", () =>
    Effect.gen(function* () {
      const notifications = yield* ElectronNotifications.ElectronNotifications;
      yield* notifications.show({
        title: "Fix flaky auth test",
        body: "Agent finished · t3code",
        silent: true,
        onActivate: () => {},
      });

      assert.deepEqual(notificationConstructorMock.mock.calls, [
        [{ title: "Fix flaky auth test", body: "Agent finished · t3code", silent: true }],
      ]);
      assert.equal(showMock.mock.calls.length, 1);
    }).pipe(Effect.provide(ElectronNotifications.layer)),
  );

  it.effect("does nothing when the platform has no notification support", () =>
    Effect.gen(function* () {
      isSupportedMock.mockReturnValue(false);

      const notifications = yield* ElectronNotifications.ElectronNotifications;
      yield* notifications.show({
        title: "Fix flaky auth test",
        body: "Agent finished",
        silent: false,
        onActivate: () => {},
      });

      assert.equal(notificationConstructorMock.mock.calls.length, 0);
      assert.equal(showMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronNotifications.layer)),
  );

  it.effect("invokes onActivate when the notification is clicked", () =>
    Effect.gen(function* () {
      let activated = 0;

      const notifications = yield* ElectronNotifications.ElectronNotifications;
      yield* notifications.show({
        title: "Fix flaky auth test",
        body: "Agent finished",
        silent: false,
        onActivate: () => {
          activated += 1;
        },
      });

      handlersByEvent.get("click")?.();
      assert.equal(activated, 1);
    }).pipe(Effect.provide(ElectronNotifications.layer)),
  );

  it.effect("survives a construction failure instead of taking the app down", () =>
    Effect.gen(function* () {
      isSupportedMock.mockImplementation(() => {
        throw new Error("notification center unavailable");
      });

      const notifications = yield* ElectronNotifications.ElectronNotifications;
      yield* notifications.show({
        title: "Fix flaky auth test",
        body: "Agent finished",
        silent: false,
        onActivate: () => {},
      });

      assert.equal(showMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronNotifications.layer)),
  );
});
