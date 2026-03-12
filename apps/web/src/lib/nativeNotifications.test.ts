import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  canShowNativeNotification,
  getNotificationPermission,
  requestNotificationPermission,
  showNativeNotification,
} from "./nativeNotifications";

type TestWindow = Window & typeof globalThis & { desktopBridge?: unknown; nativeApi?: unknown };

const getTestWindow = (): TestWindow => {
  const testGlobal = globalThis as typeof globalThis & { window?: TestWindow };
  if (!testGlobal.window) {
    testGlobal.window = {} as TestWindow;
  }
  return testGlobal.window;
};

const createNotificationMock = () => {
  const ctorSpy = vi.fn();

  class MockNotification {
    static permission: NotificationPermission = "default";
    static requestPermission = vi.fn(async () => "default" as NotificationPermission);

    constructor(title: string, options?: NotificationOptions) {
      ctorSpy({ title, options });
    }
  }

  return { MockNotification, ctorSpy };
};

beforeEach(() => {
  vi.resetModules();
  const win = getTestWindow();
  delete win.desktopBridge;
  delete win.nativeApi;
});

afterEach(() => {
  delete (globalThis as { Notification?: unknown }).Notification;
});

describe("nativeNotifications", () => {
  it("returns unsupported permission when Notification is unavailable", () => {
    delete (globalThis as { Notification?: unknown }).Notification;
    expect(getNotificationPermission()).toBe("unsupported");
  });

  it("returns permission when Notification is available", () => {
    const { MockNotification } = createNotificationMock();
    MockNotification.permission = "granted";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    expect(getNotificationPermission()).toBe("granted");
  });

  it("requests permission when supported", async () => {
    const { MockNotification } = createNotificationMock();
    MockNotification.requestPermission = vi.fn(async () => "granted");
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    await expect(requestNotificationPermission()).resolves.toBe("granted");
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("falls back to current permission when request throws", async () => {
    const { MockNotification } = createNotificationMock();
    MockNotification.permission = "denied";
    MockNotification.requestPermission = vi.fn(async () => {
      throw new Error("no");
    });
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    await expect(requestNotificationPermission()).resolves.toBe("denied");
  });

  it("canShowNativeNotification respects permission in web context", () => {
    const { MockNotification } = createNotificationMock();
    MockNotification.permission = "denied";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    expect(canShowNativeNotification()).toBe(false);
    MockNotification.permission = "granted";
    expect(canShowNativeNotification()).toBe(true);
  });

  it("canShowNativeNotification is allowed in desktop context when supported", () => {
    const { MockNotification } = createNotificationMock();
    MockNotification.permission = "denied";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (getTestWindow() as unknown as Record<string, unknown>).desktopBridge = {};

    expect(canShowNativeNotification()).toBe(true);
  });

  it("showNativeNotification returns false when permission is not granted", () => {
    const { MockNotification, ctorSpy } = createNotificationMock();
    MockNotification.permission = "denied";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    expect(showNativeNotification({ title: "Test" })).toBe(false);
    expect(ctorSpy).not.toHaveBeenCalled();
  });

  it("showNativeNotification sends a notification when allowed", () => {
    const { MockNotification, ctorSpy } = createNotificationMock();
    MockNotification.permission = "granted";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;

    expect(
      showNativeNotification({
        title: "Test",
        body: "Hello",
        tag: "tag-1",
      }),
    ).toBe(true);
    expect(ctorSpy).toHaveBeenCalledTimes(1);
  });

  it("showNativeNotification sends a notification in desktop mode", () => {
    const { MockNotification, ctorSpy } = createNotificationMock();
    MockNotification.permission = "denied";
    (globalThis as { Notification?: unknown }).Notification = MockNotification;
    (getTestWindow() as unknown as Record<string, unknown>).nativeApi = {};

    expect(showNativeNotification({ title: "Test" })).toBe(true);
    expect(ctorSpy).toHaveBeenCalledTimes(1);
  });
});
