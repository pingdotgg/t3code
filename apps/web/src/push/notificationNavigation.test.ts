import { describe, expect, it, vi, afterEach } from "vitest";

import type { AppRouter } from "../router";
import {
  readPendingNotificationClick,
  writePendingNotificationClick,
} from "./pendingNotificationClick";
import {
  consumePendingNotificationClick,
  getLastNotificationNavigationTarget,
  installServiceWorkerNotificationNavigation,
  isNotificationClickClientMessage,
  NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME,
  parseNotificationNavigationTarget,
  resetNotificationNavigationStateForTests,
  resolveNotificationUrl,
} from "./notificationNavigation";

const ORIGIN = "https://example.test";

function createCacheStorageMock() {
  const entries = new Map<string, Response>();
  const cache = {
    delete: vi.fn(async (request: Request) => entries.delete(request.url)),
    match: vi.fn(async (request: Request) => entries.get(request.url)?.clone()),
    put: vi.fn(async (request: Request, response: Response) => {
      entries.set(request.url, response.clone());
    }),
  };
  const cacheStorage = {
    open: vi.fn(async () => cache),
  };
  return {
    cache,
    cacheStorage,
  };
}

interface MockBroadcastChannelInstance extends EventTarget {
  readonly name: string;
  readonly close: ReturnType<typeof vi.fn>;
  closed: boolean;
}

function stubBroadcastChannel() {
  const channels: MockBroadcastChannelInstance[] = [];
  class MockBroadcastChannel extends EventTarget implements MockBroadcastChannelInstance {
    readonly name: string;
    closed = false;
    readonly close = vi.fn(() => {
      this.closed = true;
    });

    constructor(name: string) {
      super();
      this.name = name;
      channels.push(this);
    }
  }

  vi.stubGlobal("BroadcastChannel", MockBroadcastChannel);

  return {
    channels,
    dispatch(name: string, data: unknown) {
      for (const channel of channels) {
        if (channel.name !== name || channel.closed) {
          continue;
        }
        const event = new Event("message") as MessageEvent;
        Object.defineProperty(event, "data", { value: data });
        channel.dispatchEvent(event);
      }
    },
  };
}

function stubServiceWorker(
  options: {
    readonly broadcastChannel?: "mock" | "none";
    readonly cacheStorage?: CacheStorage;
  } = {},
) {
  const serviceWorkerTarget = new EventTarget();
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget();
  const startMessages = vi.fn();
  const broadcastChannel = options.broadcastChannel === "none" ? undefined : stubBroadcastChannel();
  if (options.broadcastChannel === "none") {
    vi.stubGlobal("BroadcastChannel", undefined);
  }
  let documentHasFocus = true;
  const windowStub: Record<string, unknown> = {
    ...(options.cacheStorage ? { caches: options.cacheStorage } : {}),
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    location: { origin: ORIGIN },
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
  };
  vi.stubGlobal("navigator", {
    serviceWorker: {
      addEventListener: serviceWorkerTarget.addEventListener.bind(serviceWorkerTarget),
      removeEventListener: serviceWorkerTarget.removeEventListener.bind(serviceWorkerTarget),
      startMessages,
    },
  });
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", {
    addEventListener: documentTarget.addEventListener.bind(documentTarget),
    hasFocus: vi.fn(() => documentHasFocus),
    removeEventListener: documentTarget.removeEventListener.bind(documentTarget),
    visibilityState: "visible",
  });

  return {
    broadcastChannel,
    dispatch(data: unknown) {
      const event = new Event("message") as MessageEvent;
      Object.defineProperty(event, "data", { value: data });
      serviceWorkerTarget.dispatchEvent(event);
    },
    dispatchWindowEvent(type: string) {
      windowTarget.dispatchEvent(new Event(type));
    },
    dispatchDocumentEvent(type: string) {
      documentTarget.dispatchEvent(new Event(type));
    },
    setCacheStorage(cacheStorage: CacheStorage) {
      windowStub.caches = cacheStorage;
    },
    setDocumentHasFocus(value: boolean) {
      documentHasFocus = value;
    },
    startMessages,
  };
}

function makeRouter() {
  return {
    navigate: vi.fn(() => Promise.resolve()),
  } as unknown as AppRouter & {
    readonly navigate: ReturnType<typeof vi.fn>;
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

async function drainPendingReplayRetries(): Promise<void> {
  for (const delayMs of [250, 500, 1000]) {
    await vi.advanceTimersByTimeAsync(delayMs);
    await flushMicrotasks();
  }
  await vi.runAllTimersAsync();
  await flushMicrotasks();
}

describe("notificationNavigation", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetNotificationNavigationStateForTests();
    vi.restoreAllMocks();
  });

  it("recognizes notification click service worker messages", () => {
    expect(
      isNotificationClickClientMessage({
        type: "t3.notification-click",
        url: "/env-1/thread-1",
      }),
    ).toBe(true);
    expect(isNotificationClickClientMessage({ type: "other", url: "/env-1/thread-1" })).toBe(false);
    expect(isNotificationClickClientMessage({ type: "t3.notification-click" })).toBe(false);
  });

  it("resolves same-origin URLs and rejects cross-origin URLs", () => {
    expect(resolveNotificationUrl("/env-1/thread-1", ORIGIN)?.href).toBe(
      "https://example.test/env-1/thread-1",
    );
    expect(resolveNotificationUrl("https://elsewhere.test/env-1/thread-1", ORIGIN)).toBeNull();
    expect(resolveNotificationUrl("http://[::1", ORIGIN)).toBeNull();
  });

  it("parses thread notification URLs", () => {
    expect(parseNotificationNavigationTarget("/env-1/thread-1", ORIGIN)).toEqual({
      kind: "thread",
      environmentId: "env-1",
      threadId: "thread-1",
    });
    expect(
      parseNotificationNavigationTarget(
        "https://example.test/env%20one/thread%2Done?diff=1",
        ORIGIN,
      ),
    ).toEqual({
      kind: "thread",
      environmentId: "env one",
      threadId: "thread-one",
    });
  });

  it("parses home, draft, settings, and pair targets", () => {
    expect(parseNotificationNavigationTarget("/", ORIGIN)).toEqual({ kind: "home" });
    expect(parseNotificationNavigationTarget("/draft/draft-1", ORIGIN)).toEqual({
      kind: "draft",
      draftId: "draft-1",
    });
    expect(parseNotificationNavigationTarget("/settings/providers", ORIGIN)).toEqual({
      kind: "settings",
      to: "/settings/providers",
    });
    expect(parseNotificationNavigationTarget("/pair", ORIGIN)).toEqual({ kind: "pair" });
  });

  it("ignores malformed or unsupported targets", () => {
    expect(
      parseNotificationNavigationTarget("https://elsewhere.test/env/thread", ORIGIN),
    ).toBeNull();
    expect(parseNotificationNavigationTarget("/settings/unknown", ORIGIN)).toBeNull();
    expect(parseNotificationNavigationTarget("/one/two/three", ORIGIN)).toBeNull();
    expect(parseNotificationNavigationTarget("/env/%E0%A4%A", ORIGIN)).toBeNull();
  });

  it("navigates service worker click messages through the app router", async () => {
    const service = await import("../environments/runtime/service");
    const reconcileSpy = vi
      .spyOn(service, "reconcileAfterNotificationClick")
      .mockImplementation(() => undefined);

    const serviceWorker = stubServiceWorker();
    const router = makeRouter();

    const cleanup = installServiceWorkerNotificationNavigation(router);
    const openedAt = Date.now();
    serviceWorker.dispatch({
      type: "t3.notification-click",
      url: "/env-1/thread-1",
      openedAt,
    });

    expect(router.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
      search: {},
    });
    expect(getLastNotificationNavigationTarget()).toEqual({
      kind: "thread",
      environmentId: "env-1",
      threadId: "thread-1",
    });
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
    expect(reconcileSpy).toHaveBeenCalledWith(
      {
        kind: "thread",
        environmentId: "env-1",
        threadId: "thread-1",
      },
      {
        openedAt,
      },
    );

    cleanup();
    serviceWorker.dispatch({
      type: "t3.notification-click",
      url: "/env-2/thread-2",
    });
    expect(router.navigate).toHaveBeenCalledTimes(1);
  });

  it("navigates broadcast click messages through the app router and clears pending clicks", async () => {
    const resumeDiagnostics = await import("../environments/runtime/resumeDiagnostics");
    const diagnosticSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");
    const service = await import("../environments/runtime/service");
    const reconcileSpy = vi
      .spyOn(service, "reconcileAfterNotificationClick")
      .mockImplementation(() => undefined);
    const { cacheStorage } = createCacheStorageMock();
    const serviceWorker = stubServiceWorker();
    const router = makeRouter();
    const openedAt = Date.now();

    const cleanup = installServiceWorkerNotificationNavigation(router);
    serviceWorker.setCacheStorage(cacheStorage as unknown as CacheStorage);
    await flushMicrotasks();
    await writePendingNotificationClick({
      url: "/env-1/thread-1",
      openedAt,
    });
    serviceWorker.broadcastChannel?.dispatch(NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME, {
      type: "t3.notification-click",
      url: "/env-1/thread-1",
      openedAt,
    });
    await flushMicrotasks();

    expect(router.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
      search: {},
    });
    expect(reconcileSpy).toHaveBeenCalledWith(
      {
        kind: "thread",
        environmentId: "env-1",
        threadId: "thread-1",
      },
      {
        openedAt,
      },
    );
    expect(diagnosticSpy).toHaveBeenCalledWith(
      "notification-navigation-message",
      expect.objectContaining({
        reason: "broadcast-channel",
        data: expect.objectContaining({
          url: "/env-1/thread-1",
          openedAt,
        }),
      }),
    );
    await expect(readPendingNotificationClick()).resolves.toBeNull();

    cleanup();
  });

  it("dedupes identical service worker and broadcast click messages", async () => {
    const resumeDiagnostics = await import("../environments/runtime/resumeDiagnostics");
    const diagnosticSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");
    const service = await import("../environments/runtime/service");
    const reconcileSpy = vi
      .spyOn(service, "reconcileAfterNotificationClick")
      .mockImplementation(() => undefined);
    const serviceWorker = stubServiceWorker();
    const router = makeRouter();
    const openedAt = Date.now();

    const cleanup = installServiceWorkerNotificationNavigation(router);
    serviceWorker.dispatch({
      type: "t3.notification-click",
      url: "/env-1/thread-1",
      openedAt,
    });
    serviceWorker.broadcastChannel?.dispatch(NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME, {
      type: "t3.notification-click",
      url: "/env-1/thread-1",
      openedAt,
    });
    expect(router.navigate).toHaveBeenCalledTimes(1);

    serviceWorker.broadcastChannel?.dispatch(NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME, {
      type: "t3.notification-click",
      url: "/env-1/thread-1",
      openedAt: openedAt + 1,
    });

    expect(router.navigate).toHaveBeenCalledTimes(2);
    expect(reconcileSpy).toHaveBeenCalledTimes(2);
    expect(diagnosticSpy).toHaveBeenCalledWith(
      "notification-navigation-message",
      expect.objectContaining({
        reason: "duplicate",
        data: expect.objectContaining({
          source: "broadcast-channel",
          url: "/env-1/thread-1",
          openedAt,
        }),
      }),
    );

    cleanup();
  });

  it("dedupes a pending-cache replay of a broadcast click", async () => {
    const service = await import("../environments/runtime/service");
    vi.spyOn(service, "reconcileAfterNotificationClick").mockImplementation(() => undefined);
    const { cacheStorage } = createCacheStorageMock();
    const serviceWorker = stubServiceWorker();
    const router = makeRouter();
    const openedAt = Date.now();

    const cleanup = installServiceWorkerNotificationNavigation(router);
    serviceWorker.setCacheStorage(cacheStorage as unknown as CacheStorage);
    await flushMicrotasks();
    serviceWorker.broadcastChannel?.dispatch(NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME, {
      type: "t3.notification-click",
      url: "/env-1/thread-1",
      openedAt,
    });
    await writePendingNotificationClick({
      url: "/env-1/thread-1",
      openedAt,
    });
    await consumePendingNotificationClick(router, "test-cache-replay");

    expect(router.navigate).toHaveBeenCalledTimes(1);
    await expect(readPendingNotificationClick()).resolves.toBeNull();

    cleanup();
  });

  it("ignores broadcast click messages when the document is not focused", async () => {
    const resumeDiagnostics = await import("../environments/runtime/resumeDiagnostics");
    const diagnosticSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");
    const { cacheStorage } = createCacheStorageMock();
    const serviceWorker = stubServiceWorker();
    const router = makeRouter();
    const openedAt = Date.now();

    const cleanup = installServiceWorkerNotificationNavigation(router);
    serviceWorker.setCacheStorage(cacheStorage as unknown as CacheStorage);
    await flushMicrotasks();
    await writePendingNotificationClick({
      url: "/env-1/thread-1",
      openedAt,
    });
    serviceWorker.setDocumentHasFocus(false);
    serviceWorker.broadcastChannel?.dispatch(NOTIFICATION_CLICK_BROADCAST_CHANNEL_NAME, {
      type: "t3.notification-click",
      url: "/env-1/thread-1",
      openedAt,
    });
    await flushMicrotasks();

    expect(router.navigate).not.toHaveBeenCalled();
    await expect(readPendingNotificationClick()).resolves.toEqual({
      url: "/env-1/thread-1",
      openedAt,
    });
    expect(diagnosticSpy).toHaveBeenCalledWith(
      "notification-navigation-message",
      expect.objectContaining({
        reason: "broadcast-ignored-unfocused",
      }),
    );

    cleanup();
  });

  it("closes the broadcast channel during cleanup", () => {
    const serviceWorker = stubServiceWorker();
    const router = makeRouter();

    const cleanup = installServiceWorkerNotificationNavigation(router);
    const [channel] = serviceWorker.broadcastChannel?.channels ?? [];
    expect(channel?.closed).toBe(false);

    cleanup();

    expect(channel?.close).toHaveBeenCalledTimes(1);
    expect(channel?.closed).toBe(true);
  });

  it("does not throw when BroadcastChannel is unavailable", () => {
    const serviceWorker = stubServiceWorker({ broadcastChannel: "none" });
    const router = makeRouter();

    const cleanup = installServiceWorkerNotificationNavigation(router);

    cleanup();
    expect(serviceWorker.broadcastChannel).toBeUndefined();
    expect(router.navigate).not.toHaveBeenCalled();
  });

  it("starts service worker message delivery when installed", () => {
    const serviceWorker = stubServiceWorker();
    const router = makeRouter();

    const cleanup = installServiceWorkerNotificationNavigation(router);

    expect(serviceWorker.startMessages).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("replays a persisted notification target on startup", async () => {
    const service = await import("../environments/runtime/service");
    const reconcileSpy = vi
      .spyOn(service, "reconcileAfterNotificationClick")
      .mockImplementation(() => undefined);
    const { cacheStorage } = createCacheStorageMock();
    stubServiceWorker({ cacheStorage: cacheStorage as unknown as CacheStorage });
    const router = makeRouter();
    const openedAt = Date.now();

    await writePendingNotificationClick({
      url: "/env-1/thread-1",
      openedAt,
    });

    const cleanup = installServiceWorkerNotificationNavigation(router);
    await flushAsync();

    expect(router.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
      search: {},
    });
    expect(getLastNotificationNavigationTarget()).toEqual({
      kind: "thread",
      environmentId: "env-1",
      threadId: "thread-1",
    });
    expect(reconcileSpy).toHaveBeenCalledWith(
      {
        kind: "thread",
        environmentId: "env-1",
        threadId: "thread-1",
      },
      {
        openedAt,
      },
    );
    await expect(readPendingNotificationClick()).resolves.toBeNull();

    cleanup();
  });

  it("does not let cleaned-up startup replays consume later pending clicks", async () => {
    vi.useFakeTimers();
    const service = await import("../environments/runtime/service");
    vi.spyOn(service, "reconcileAfterNotificationClick").mockImplementation(() => undefined);
    const { cacheStorage } = createCacheStorageMock();
    stubServiceWorker({ cacheStorage: cacheStorage as unknown as CacheStorage });
    const staleRouter = makeRouter();
    const openedAt = Date.now();

    const cleanupStaleRouter = installServiceWorkerNotificationNavigation(staleRouter);
    await flushMicrotasks();
    cleanupStaleRouter();

    await writePendingNotificationClick({
      url: "/env-1/thread-1",
      openedAt,
    });
    await drainPendingReplayRetries();

    expect(staleRouter.navigate).not.toHaveBeenCalled();
    await expect(readPendingNotificationClick()).resolves.toEqual({
      url: "/env-1/thread-1",
      openedAt,
    });

    const activeRouter = makeRouter();
    const cleanupActiveRouter = installServiceWorkerNotificationNavigation(activeRouter);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(activeRouter.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: "env-1",
        threadId: "thread-1",
      },
      search: {},
    });
    await expect(readPendingNotificationClick()).resolves.toBeNull();

    cleanupActiveRouter();
  });

  it("replays a persisted notification target on focus", async () => {
    vi.useFakeTimers();
    const service = await import("../environments/runtime/service");
    vi.spyOn(service, "reconcileAfterNotificationClick").mockImplementation(() => undefined);
    const { cacheStorage } = createCacheStorageMock();
    const serviceWorker = stubServiceWorker({
      cacheStorage: cacheStorage as unknown as CacheStorage,
    });
    const router = makeRouter();

    const cleanup = installServiceWorkerNotificationNavigation(router);
    await flushMicrotasks();
    await drainPendingReplayRetries();
    expect(router.navigate).not.toHaveBeenCalled();

    await writePendingNotificationClick({
      url: "/env-2/thread-2",
      openedAt: Date.now(),
    });
    serviceWorker.dispatchWindowEvent("focus");
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(router.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: "env-2",
        threadId: "thread-2",
      },
      search: {},
    });

    cleanup();
  });

  it("retries replay when a pending notification click is written after visibility resumes", async () => {
    vi.useFakeTimers();
    const service = await import("../environments/runtime/service");
    vi.spyOn(service, "reconcileAfterNotificationClick").mockImplementation(() => undefined);
    const { cacheStorage } = createCacheStorageMock();
    const serviceWorker = stubServiceWorker({
      cacheStorage: cacheStorage as unknown as CacheStorage,
    });
    const router = makeRouter();

    const cleanup = installServiceWorkerNotificationNavigation(router);
    await flushMicrotasks();
    await drainPendingReplayRetries();
    expect(router.navigate).not.toHaveBeenCalled();

    serviceWorker.dispatchDocumentEvent("visibilitychange");
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);
    await writePendingNotificationClick({
      url: "/env-3/thread-3",
      openedAt: Date.now(),
    });
    await vi.advanceTimersByTimeAsync(150);
    await flushMicrotasks();

    expect(router.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: "env-3",
        threadId: "thread-3",
      },
      search: {},
    });
    await expect(readPendingNotificationClick()).resolves.toBeNull();

    cleanup();
  });

  it("clears stale persisted notification clicks without navigating", async () => {
    const service = await import("../environments/runtime/service");
    const resumeDiagnostics = await import("../environments/runtime/resumeDiagnostics");
    const reconcileSpy = vi
      .spyOn(service, "reconcileAfterNotificationClick")
      .mockImplementation(() => undefined);
    const diagnosticSpy = vi.spyOn(resumeDiagnostics, "recordResumeDiagnostic");
    const { cacheStorage } = createCacheStorageMock();
    stubServiceWorker({ cacheStorage: cacheStorage as unknown as CacheStorage });
    const router = makeRouter();
    const openedAt = Date.now() - 2 * 60 * 1000 - 1;

    await writePendingNotificationClick({
      url: "/env-4/thread-4",
      openedAt,
    });
    await consumePendingNotificationClick(router, "test");

    expect(router.navigate).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(diagnosticSpy).toHaveBeenCalledWith(
      "notification-navigation-pending",
      expect.objectContaining({
        reason: "stale",
        data: expect.objectContaining({
          replayReason: "test",
          url: "/env-4/thread-4",
          openedAt,
        }),
      }),
    );
    await expect(readPendingNotificationClick()).resolves.toBeNull();
  });

  it("clears malformed or cross-origin persisted notification targets", async () => {
    const service = await import("../environments/runtime/service");
    const reconcileSpy = vi
      .spyOn(service, "reconcileAfterNotificationClick")
      .mockImplementation(() => undefined);
    const { cacheStorage } = createCacheStorageMock();
    stubServiceWorker({ cacheStorage: cacheStorage as unknown as CacheStorage });
    const router = makeRouter();

    await writePendingNotificationClick({
      url: "https://elsewhere.test/env-1/thread-1",
      openedAt: Date.now(),
    });
    await consumePendingNotificationClick(router, "test");

    expect(router.navigate).not.toHaveBeenCalled();
    expect(reconcileSpy).not.toHaveBeenCalled();
    await expect(readPendingNotificationClick()).resolves.toBeNull();
  });

  it("does nothing when service workers are unavailable", () => {
    vi.stubGlobal("navigator", {});
    const router = makeRouter();

    const cleanup = installServiceWorkerNotificationNavigation(router);

    cleanup();
    expect(router.navigate).not.toHaveBeenCalled();
  });
});
