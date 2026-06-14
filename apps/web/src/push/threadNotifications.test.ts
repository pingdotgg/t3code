import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearTurnCompletionAlerts,
  closeThreadNotifications,
  closeTurnCompletionNotifications,
  countTurnCompletionNotificationThreads,
  getDisplayedTurnCompletionThreadCount,
  requestServiceWorkerBadgeSync,
  requestServiceWorkerTurnCompletionNotificationClear,
} from "./notifications";

interface FakeNotification {
  readonly tag: unknown;
  closed: boolean;
  readonly close: () => void;
}

function makeNotification(tag: unknown): FakeNotification {
  const notification: FakeNotification = {
    tag,
    closed: false,
    close: () => {
      notification.closed = true;
    },
  };
  return notification;
}

function installPushSupport(getRegistration: () => Promise<unknown>): void {
  vi.stubGlobal("window", {
    isSecureContext: true,
    PushManager: function PushManager() {},
    Notification: function Notification() {},
  });
  vi.stubGlobal("navigator", {
    serviceWorker: { getRegistration },
  });
}

describe("countTurnCompletionNotificationThreads", () => {
  it("counts distinct completed-turn threads only", () => {
    expect(
      countTurnCompletionNotificationThreads([
        makeNotification("thread:thread-1:turn:turn-1"),
        makeNotification("thread:thread-1:turn:turn-2"),
        makeNotification("thread:thread-2:turn:event-1"),
        makeNotification("thread:thread-2:approval:activity-1"),
        makeNotification("thread:thread-3:input:activity-2"),
        makeNotification("thread:thread-4:turn:"),
        makeNotification("thread:thread-5:turn:turn-1:extra"),
        makeNotification("salchi"),
        makeNotification(2),
      ]),
    ).toBe(2);
  });
});

describe("closeThreadNotifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes only notifications whose tag matches the thread prefix", async () => {
    const notifications = [
      makeNotification("thread:thread-1:turn:turn-1"),
      makeNotification("thread:thread-1:approval:activity-1"),
      makeNotification("thread:thread-2:turn:turn-1"),
      makeNotification("t3code"),
    ];
    installPushSupport(async () => ({
      getNotifications: async () => notifications,
    }));

    await closeThreadNotifications("thread-1");

    expect(notifications.map((notification) => notification.closed)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("is a no-op when there is no service worker registration", async () => {
    const getRegistration = vi.fn(async () => null);
    installPushSupport(getRegistration);

    await expect(closeThreadNotifications("thread-1")).resolves.toBeUndefined();
    expect(getRegistration).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when push is unsupported", async () => {
    const getRegistration = vi.fn(async () => null);
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });

    await expect(closeThreadNotifications("thread-1")).resolves.toBeUndefined();
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it("swallows errors from the service worker registration lookup", async () => {
    installPushSupport(async () => {
      throw new Error("registration lookup failed");
    });

    await expect(closeThreadNotifications("thread-1")).resolves.toBeUndefined();
  });
});

describe("getDisplayedTurnCompletionThreadCount", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the distinct completed-turn thread count from displayed notifications", async () => {
    installPushSupport(async () => ({
      getNotifications: async () => [
        makeNotification("thread:thread-1:turn:turn-1"),
        makeNotification("thread:thread-1:turn:turn-2"),
        makeNotification("thread:thread-2:turn:turn-1"),
        makeNotification("thread:thread-2:approval:activity-1"),
      ],
    }));

    await expect(getDisplayedTurnCompletionThreadCount()).resolves.toBe(2);
  });

  it("returns null when displayed notifications cannot be inspected", async () => {
    installPushSupport(async () => null);

    await expect(getDisplayedTurnCompletionThreadCount()).resolves.toBeNull();
  });

  it("returns null when push support is unavailable", async () => {
    vi.stubGlobal("window", { isSecureContext: false });

    await expect(getDisplayedTurnCompletionThreadCount()).resolves.toBeNull();
  });
});

describe("closeTurnCompletionNotifications", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes only completed-turn notifications across all threads", async () => {
    const notifications = [
      makeNotification("thread:thread-1:turn:turn-1"),
      makeNotification("thread:thread-1:approval:activity-1"),
      makeNotification("thread:thread-2:turn:turn-1"),
      makeNotification("salchi"),
    ];
    installPushSupport(async () => ({
      getNotifications: async () => notifications,
    }));

    await expect(closeTurnCompletionNotifications()).resolves.toBe(2);

    expect(notifications.map((notification) => notification.closed)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it("returns null when completed-turn notifications cannot be inspected", async () => {
    installPushSupport(async () => null);

    await expect(closeTurnCompletionNotifications()).resolves.toBeNull();
  });
});

describe("requestServiceWorkerBadgeSync", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a sync request to the active service worker", async () => {
    const postMessage = vi.fn();
    installPushSupport(async () => ({
      active: { postMessage },
    }));

    await expect(requestServiceWorkerBadgeSync()).resolves.toBe(true);

    expect(postMessage).toHaveBeenCalledWith({
      type: "t3.sync-displayed-notification-badge",
    });
  });

  it("uses an explicit registration without looking it up", async () => {
    const postMessage = vi.fn();
    const getRegistration = vi.fn(async () => null);
    installPushSupport(getRegistration);

    await expect(
      requestServiceWorkerBadgeSync({
        active: { postMessage },
      } as unknown as ServiceWorkerRegistration),
    ).resolves.toBe(true);

    expect(getRegistration).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("returns false when no service worker can receive the request", async () => {
    installPushSupport(async () => ({}));

    await expect(requestServiceWorkerBadgeSync()).resolves.toBe(false);
  });
});

describe("requestServiceWorkerTurnCompletionNotificationClear", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts a clear request to the active service worker", async () => {
    const postMessage = vi.fn();
    installPushSupport(async () => ({
      active: { postMessage },
    }));

    await expect(requestServiceWorkerTurnCompletionNotificationClear()).resolves.toBe(true);

    expect(postMessage).toHaveBeenCalledWith({
      type: "t3.clear-turn-completion-notifications",
    });
  });
});

describe("clearTurnCompletionAlerts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes page-visible completed-turn notifications and asks the worker to clear", async () => {
    const postMessage = vi.fn();
    const notifications = [
      makeNotification("thread:thread-1:turn:turn-1"),
      makeNotification("thread:thread-2:approval:activity-1"),
    ];
    installPushSupport(async () => ({
      active: { postMessage },
      getNotifications: async () => notifications,
    }));

    await expect(clearTurnCompletionAlerts()).resolves.toBeUndefined();

    expect(notifications.map((notification) => notification.closed)).toEqual([true, false]);
    expect(postMessage).toHaveBeenCalledWith({
      type: "t3.clear-turn-completion-notifications",
    });
  });
});

describe("closeThreadNotifications input guards", () => {
  let originalNavigator: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
  });

  it("does nothing for an empty thread id", async () => {
    const getRegistration = vi.fn(async () => null);
    installPushSupport(getRegistration);

    await closeThreadNotifications("");

    expect(getRegistration).not.toHaveBeenCalled();
  });
});
