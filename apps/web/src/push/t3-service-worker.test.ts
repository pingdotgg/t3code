// @effect-diagnostics nodeBuiltinImport:off - Service worker tests execute browser worker assets in a Node VM.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGIN = "https://t3.example";
const TARGET_URL = `${ORIGIN}/env-1/thread-1`;
const HOME_URL = `${ORIGIN}/`;
const CROSS_ORIGIN_URL = "https://elsewhere.example/env-1/thread-1";
const DEFAULT_NOTIFICATION_TITLE = "Salchi";

interface MockClientState {
  readonly id: string;
  readonly url: string;
  readonly controlled: boolean;
  readonly focusCalls: number;
  readonly navigateCalls: string[];
  readonly postMessageCalls: Array<{
    readonly type: string;
    readonly url: string;
    readonly openedAt: number;
  }>;
}

interface ServiceWorkerTestHarness {
  readonly context: vm.Context;
  readonly openWindowCalls: string[];
  readonly operationLog: string[];
  readonly getClients: () => MockClientState[];
  readonly getBroadcastMessages: () => Array<{
    readonly name: string;
    readonly message: unknown;
  }>;
  readonly getBroadcastCloseCalls: () => string[];
  readonly getPendingClickWrites: () => Array<{
    readonly cacheName: string;
    readonly requestUrl: string;
    readonly value: unknown;
  }>;
  readonly getBadgeSetCalls: () => number[];
  readonly getBadgeClearCallCount: () => number;
  readonly getDisplayedNotificationCount: () => number;
  readonly closeAllDisplayedNotificationsWithoutEvent: () => void;
  readonly dispatchActivate: () => Promise<void>;
  readonly dispatchMessage: (payload: unknown) => Promise<void>;
  readonly dispatchPush: (payload: unknown) => Promise<void>;
  readonly dispatchNotificationClick: (index?: number) => Promise<void>;
  readonly dispatchNotificationClose: (index?: number) => Promise<void>;
  readonly removeAppBadgeSupport: () => void;
  readonly addClient: (options: {
    readonly url: string;
    readonly controlled?: boolean;
    readonly focusResult?: "self" | "throw";
    readonly focused?: boolean;
    readonly visibilityState?: "hidden" | "visible";
    readonly navigateResult?: "self" | "null" | "throw";
  }) => void;
  readonly setOpenWindowResult: (
    result: "undefined" | "client-at-url" | "client-at-home" | "throw",
  ) => void;
  readonly removeBroadcastChannel: () => void;
}

function createServiceWorkerTestHarness(): ServiceWorkerTestHarness {
  const openWindowCalls: string[] = [];
  const operationLog: string[] = [];
  const broadcastMessages: Array<{
    name: string;
    message: unknown;
  }> = [];
  const broadcastCloseCalls: string[] = [];
  const pendingClickWrites: Array<{
    cacheName: string;
    requestUrl: string;
    value: unknown;
  }> = [];
  const badgeSetCalls: number[] = [];
  let badgeClearCallCount = 0;
  const eventListeners: Record<string, Array<(event: unknown) => void>> = {};
  const displayedNotifications: Array<
    Record<string, unknown> & {
      __closed: boolean;
      close: () => void;
    }
  > = [];
  let openWindowResult: "undefined" | "client-at-url" | "client-at-home" | "throw" = "undefined";
  let nextClientId = 1;
  const makeClient = (options: {
    readonly url: string;
    readonly controlled?: boolean;
    readonly focusResult?: "self" | "throw";
    readonly focused?: boolean;
    readonly visibilityState?: "hidden" | "visible";
    readonly navigateResult?: "self" | "null" | "throw";
  }) => {
    const client: Record<string, unknown> = {
      id: `client-${nextClientId++}`,
      url: options.url,
      __controlled: options.controlled ?? true,
      focused: options.focused === true,
      visibilityState: options.visibilityState ?? "visible",
      focusCalls: 0,
      navigateCalls: [],
      postMessageCalls: [],
    };
    client.focus = async () => {
      operationLog.push("focus");
      client.focusCalls = Number(client.focusCalls ?? 0) + 1;
      if (options.focusResult === "throw") {
        throw new Error("focus failed");
      }
      return client;
    };
    if (options.navigateResult !== undefined) {
      client.navigate = async (url: string) => {
        operationLog.push("navigate");
        (client.navigateCalls as string[]).push(url);
        if (options.navigateResult === "throw") {
          throw new Error("navigate failed");
        }
        if (options.navigateResult === "null") {
          return null;
        }
        client.url = url;
        return client;
      };
    }
    client.postMessage = (message: unknown) => {
      (client.postMessageCalls as unknown[]).push(message);
    };
    return client;
  };
  class MockBroadcastChannel {
    readonly name: string;

    constructor(name: string) {
      this.name = name;
    }

    postMessage(message: unknown) {
      operationLog.push("broadcast");
      broadcastMessages.push({
        name: this.name,
        message,
      });
    }

    close() {
      operationLog.push("broadcast-close");
      broadcastCloseCalls.push(this.name);
    }
  }
  const makeNotification = (title: string, options: Record<string, unknown>) => {
    const notification: Record<string, unknown> & {
      __closed: boolean;
      close: () => void;
    } = {
      ...options,
      title,
      __closed: false,
      close: () => {
        operationLog.push("notification-close");
        notification.__closed = true;
      },
    };
    return notification;
  };

  const context: Record<string, unknown> = {
    Request,
    Response,
    URL,
    console,
    __windowClients: [] as Array<Record<string, unknown>>,
    self: {
      location: { origin: ORIGIN, href: `${ORIGIN}/` },
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        (eventListeners[type] ??= []).push(listener);
      }),
      removeEventListener: vi.fn(),
      skipWaiting: vi.fn(),
      navigator: {
        setAppBadge: async (count?: number) => {
          operationLog.push("setAppBadge");
          badgeSetCalls.push(Number(count));
        },
        clearAppBadge: async () => {
          operationLog.push("clearAppBadge");
          badgeClearCallCount += 1;
        },
      },
      registration: {
        showNotification: async (title: string, options: Record<string, unknown>) => {
          operationLog.push("showNotification");
          const notification = makeNotification(title, options);
          const tag = typeof notification.tag === "string" ? notification.tag : null;
          const existingIndex = tag
            ? displayedNotifications.findIndex(
                (candidate) => candidate.__closed !== true && candidate.tag === tag,
              )
            : -1;
          if (existingIndex >= 0) {
            displayedNotifications.splice(existingIndex, 1, notification);
            return;
          }
          displayedNotifications.push(notification);
        },
        getNotifications: async () =>
          displayedNotifications.filter((notification) => notification.__closed !== true),
      },
      clients: {
        matchAll: async (options?: { readonly includeUncontrolled?: boolean }) => {
          const clients = context.__windowClients as Array<Record<string, unknown>>;
          if (options?.includeUncontrolled === true) {
            return clients;
          }
          return clients.filter((client) => client.__controlled === true);
        },
        openWindow: async (url: string) => {
          operationLog.push("openWindow");
          openWindowCalls.push(url);
          if (openWindowResult === "throw") {
            throw new Error("openWindow failed");
          }
          if (openWindowResult === "undefined") {
            return undefined;
          }
          const client = makeClient({
            url: openWindowResult === "client-at-home" ? HOME_URL : url,
          });
          (context.__windowClients as Array<Record<string, unknown>>).push(client);
          return client;
        },
      },
      caches: {
        open: async (cacheName: string) => ({
          put: async (request: Request, response: Response) => {
            operationLog.push("persist");
            pendingClickWrites.push({
              cacheName,
              requestUrl: request.url,
              value: await response.json(),
            });
          },
        }),
      },
      BroadcastChannel: MockBroadcastChannel,
    },
  };

  const serviceWorkerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../public/t3-push-service-worker.js",
  );
  const source = readFileSync(serviceWorkerPath, "utf8");

  vm.createContext(context);
  vm.runInContext(
    `${source}
this.__t3ServiceWorkerTestExports = {
  notificationTitle,
  openNotificationUrl,
};`,
    context,
  );

  return {
    context,
    openWindowCalls,
    operationLog,
    getClients: () =>
      (context.__windowClients as Array<Record<string, unknown>>).map((client) => ({
        id: String(client.id),
        url: String(client.url),
        controlled: client.__controlled === true,
        focusCalls: Number(client.focusCalls ?? 0),
        navigateCalls: (client.navigateCalls as string[] | undefined) ?? [],
        postMessageCalls:
          (client.postMessageCalls as MockClientState["postMessageCalls"] | undefined) ?? [],
      })),
    getBroadcastMessages: () => broadcastMessages,
    getBroadcastCloseCalls: () => broadcastCloseCalls,
    getPendingClickWrites: () => pendingClickWrites,
    getBadgeSetCalls: () => badgeSetCalls,
    getBadgeClearCallCount: () => badgeClearCallCount,
    getDisplayedNotificationCount: () =>
      displayedNotifications.filter((notification) => notification.__closed !== true).length,
    closeAllDisplayedNotificationsWithoutEvent: () => {
      for (const notification of displayedNotifications) {
        if (notification.__closed !== true) {
          notification.close();
        }
      }
    },
    dispatchActivate: async () => {
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.activate ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    dispatchMessage: async (payload) => {
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        data: payload,
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.message ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    dispatchPush: async (payload) => {
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        data: {
          json: () => payload,
        },
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.push ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    dispatchNotificationClick: async (index = 0) => {
      const notification = displayedNotifications.filter(
        (candidate) => candidate.__closed !== true,
      )[index];
      if (!notification) {
        throw new Error(`No displayed notification at index ${index}`);
      }
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        notification,
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.notificationclick ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    dispatchNotificationClose: async (index = 0) => {
      const notification = displayedNotifications.filter(
        (candidate) => candidate.__closed !== true,
      )[index];
      if (!notification) {
        throw new Error(`No displayed notification at index ${index}`);
      }
      // The browser removes the notification before dispatching notificationclose.
      notification.close();
      const waitUntilPromises: Array<Promise<unknown>> = [];
      const event = {
        notification,
        waitUntil: (promise: Promise<unknown>) => {
          waitUntilPromises.push(Promise.resolve(promise));
        },
      };
      for (const listener of eventListeners.notificationclose ?? []) {
        listener(event);
      }
      await Promise.all(waitUntilPromises);
    },
    addClient: (options) => {
      (context.__windowClients as Array<Record<string, unknown>>).push(makeClient(options));
    },
    setOpenWindowResult: (result) => {
      openWindowResult = result;
    },
    removeBroadcastChannel: () => {
      delete (context.self as Record<string, unknown>).BroadcastChannel;
    },
    removeAppBadgeSupport: () => {
      (context.self as Record<string, unknown>).navigator = {};
    },
  };
}

async function openNotificationUrl(harness: ServiceWorkerTestHarness, url: string): Promise<void> {
  await vm.runInContext(
    `__t3ServiceWorkerTestExports.openNotificationUrl(${JSON.stringify(url)})`,
    harness.context,
  );
}

function notificationTitle(harness: ServiceWorkerTestHarness, rawTitle: unknown): string {
  return String(
    vm.runInContext(
      `__t3ServiceWorkerTestExports.notificationTitle(${JSON.stringify(rawTitle)})`,
      harness.context,
    ),
  );
}

describe("t3-service-worker app badge", () => {
  let harness: ServiceWorkerTestHarness;

  beforeEach(() => {
    harness = createServiceWorkerTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts distinct threads with completed turns after pushes", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-2:turn:turn-1",
      url: `${ORIGIN}/env-1/thread-2`,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(2);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("does not badge approval or user-input request notifications", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:approval:activity-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-1:input:activity-2",
      url: TARGET_URL,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(2);
    expect(harness.getBadgeSetCalls()).toEqual([]);
  });

  it("does not badge notifications with the default tag", async () => {
    await harness.dispatchPush({ url: TARGET_URL });

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([]);
  });

  it("counts a single thread once when multiple turns complete", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-2",
      url: TARGET_URL,
    });

    expect(harness.getBadgeSetCalls()).toEqual([1, 1]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("closes prior notifications for a thread when a new turn completes", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:approval:activity-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([1]);
  });

  it("syncs push badge writes even while a visible same-origin page is open", async () => {
    harness.addClient({
      url: HOME_URL,
      focused: true,
      visibilityState: "visible",
    });

    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([1]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("decrements and clears the badge when notifications are clicked", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-2:turn:turn-1",
      url: `${ORIGIN}/env-1/thread-2`,
    });

    await harness.dispatchNotificationClick(0);

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2, 1]);
    expect(harness.getBadgeClearCallCount()).toBe(0);

    await harness.dispatchNotificationClick(0);

    expect(harness.getDisplayedNotificationCount()).toBe(0);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2, 1]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });

  it("resyncs the badge when a notification is dismissed", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-2:turn:turn-1",
      url: `${ORIGIN}/env-1/thread-2`,
    });

    await harness.dispatchNotificationClose(0);

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2, 1]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("resyncs dismissal while a visible same-origin page is open", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    harness.addClient({
      url: HOME_URL,
      focused: true,
      visibilityState: "visible",
    });

    await harness.dispatchNotificationClose(0);

    expect(harness.getBadgeSetCalls()).toEqual([1]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });

  it("does nothing when app badge support is unavailable", async () => {
    harness.removeAppBadgeSupport();

    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });

    expect(harness.getDisplayedNotificationCount()).toBe(1);
    expect(harness.getBadgeSetCalls()).toEqual([]);
    expect(harness.getBadgeClearCallCount()).toBe(0);
  });

  it("clears completed-turn notifications when the page requests alert clearing", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    await harness.dispatchPush({
      tag: "thread:thread-2:turn:turn-1",
      url: `${ORIGIN}/env-1/thread-2`,
    });

    await harness.dispatchMessage({ type: "t3.clear-turn-completion-notifications" });

    expect(harness.getDisplayedNotificationCount()).toBe(0);
    expect(harness.getBadgeSetCalls()).toEqual([1, 2]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });

  it("clears a stale badge when the page requests a badge sync after notifications disappeared", async () => {
    await harness.dispatchPush({
      tag: "thread:thread-1:turn:turn-1",
      url: TARGET_URL,
    });
    harness.closeAllDisplayedNotificationsWithoutEvent();

    await harness.dispatchMessage({ type: "t3.sync-displayed-notification-badge" });

    expect(harness.getDisplayedNotificationCount()).toBe(0);
    expect(harness.getBadgeSetCalls()).toEqual([1]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });

  it("syncs the displayed-notification badge on activation", async () => {
    await harness.dispatchActivate();

    expect(harness.getBadgeSetCalls()).toEqual([]);
    expect(harness.getBadgeClearCallCount()).toBe(1);
  });
});

describe("t3-service-worker notification click navigation", () => {
  let harness: ServiceWorkerTestHarness;

  beforeEach(() => {
    harness = createServiceWorkerTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("strips the app source suffix from notification titles", () => {
    expect(notificationTitle(harness, "Investigate deploy from Salchi")).toBe("Investigate deploy");
    expect(notificationTitle(harness, "Investigate deploy")).toBe("Investigate deploy");
    expect(notificationTitle(harness, "from Salchi")).toBe(DEFAULT_NOTIFICATION_TITLE);
  });

  it("opens a new window with the full URL when no same-origin client exists", async () => {
    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
  });

  it("broadcasts the notification click and closes the channel before window operations", async () => {
    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.getBroadcastMessages()).toEqual([
      {
        name: "t3-notification-click",
        message: {
          type: "t3.notification-click",
          url: TARGET_URL,
          openedAt: expect.any(Number),
        },
      },
    ]);
    expect(harness.getBroadcastCloseCalls()).toEqual(["t3-notification-click"]);
    expect(harness.operationLog.indexOf("persist")).toBeLessThan(
      harness.operationLog.indexOf("broadcast"),
    );
    expect(harness.operationLog.indexOf("broadcast")).toBeLessThan(
      harness.operationLog.indexOf("openWindow"),
    );
  });

  it("broadcasts the notification click when an existing client handles the click", async () => {
    harness.addClient({ url: TARGET_URL, focused: true });

    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.getBroadcastMessages()).toEqual([
      {
        name: "t3-notification-click",
        message: {
          type: "t3.notification-click",
          url: TARGET_URL,
          openedAt: expect.any(Number),
        },
      },
    ]);
    expect(harness.getBroadcastCloseCalls()).toEqual(["t3-notification-click"]);
  });

  it("continues notification click handling when BroadcastChannel is unavailable", async () => {
    harness.removeBroadcastChannel();

    await openNotificationUrl(harness, TARGET_URL);

    expect(harness.getBroadcastMessages()).toEqual([]);
    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
  });

  it("posts the notification click to the client returned by openWindow", async () => {
    harness.setOpenWindowResult("client-at-home");

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
    expect(client?.url).toBe(HOME_URL);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
  });

  it("persists the notification click before window operations", async () => {
    harness.addClient({ url: TARGET_URL, focused: true, navigateResult: "self" });

    await openNotificationUrl(harness, TARGET_URL);

    const [write] = harness.getPendingClickWrites();
    expect(write).toMatchObject({
      cacheName: "t3-notification-click-v1",
      requestUrl: `${ORIGIN}/__t3-notification-click/pending`,
      value: {
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    });
    expect(harness.operationLog.indexOf("persist")).toBeLessThan(
      harness.operationLog.indexOf("focus"),
    );
  });

  it("ignores cross-origin clients when deciding whether the app is open", async () => {
    harness.addClient({ url: CROSS_ORIGIN_URL, focused: true });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(0);
    expect(client?.postMessageCalls).toEqual([]);
    expect(harness.openWindowCalls).toEqual([TARGET_URL]);
  });

  it("focuses an exact-url client without navigating", async () => {
    harness.addClient({ url: TARGET_URL, focused: true, navigateResult: "self" });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("treats trailing-slash variants as an exact-url match", async () => {
    harness.addClient({ url: `${TARGET_URL}/`, focused: true, navigateResult: "self" });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.postMessageCalls).toHaveLength(1);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses and posts to a controlled client without navigating", async () => {
    harness.addClient({
      url: HOME_URL,
      focused: true,
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("navigates a focused same-origin client before posting the click message", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      focused: true,
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(TARGET_URL);
    expect(client?.navigateCalls).toEqual([TARGET_URL]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("navigates a hidden same-origin client without opening a new window", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      visibilityState: "hidden",
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(TARGET_URL);
    expect(client?.navigateCalls).toEqual([TARGET_URL]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses and posts without opening a new window when navigate is unavailable", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      focused: true,
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses and posts without opening a new window when navigation returns null", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      focused: true,
      navigateResult: "null",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([TARGET_URL]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("focuses and posts without opening a new window when navigation throws", async () => {
    harness.addClient({
      url: HOME_URL,
      controlled: false,
      focused: true,
      navigateResult: "throw",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.url).toBe(HOME_URL);
    expect(client?.navigateCalls).toEqual([TARGET_URL]);
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("posts the notification click when focus throws", async () => {
    harness.addClient({
      url: TARGET_URL,
      focused: true,
      focusResult: "throw",
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [client] = harness.getClients();
    expect(client?.focusCalls).toBe(1);
    expect(client?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });

  it("selects the exact target URL before a focused same-origin client", async () => {
    harness.addClient({
      url: HOME_URL,
      focused: true,
      navigateResult: "self",
    });
    harness.addClient({
      url: TARGET_URL,
      focused: false,
      navigateResult: "self",
    });

    await openNotificationUrl(harness, TARGET_URL);

    const [homeClient, targetClient] = harness.getClients();
    expect(homeClient?.focusCalls).toBe(0);
    expect(homeClient?.postMessageCalls).toEqual([]);
    expect(targetClient?.focusCalls).toBe(1);
    expect(targetClient?.navigateCalls).toEqual([]);
    expect(targetClient?.postMessageCalls).toEqual([
      {
        type: "t3.notification-click",
        url: TARGET_URL,
        openedAt: expect.any(Number),
      },
    ]);
    expect(harness.openWindowCalls).toEqual([]);
  });
});
