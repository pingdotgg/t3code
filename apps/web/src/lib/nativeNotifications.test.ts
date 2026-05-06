import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { NotificationLevel } from "@t3tools/contracts/settings";

import {
  canShowNativeNotification,
  getNotificationPermission,
  requestNotificationPermission,
  resolveAttentionNotification,
  resolveTurnCompletionNotification,
  showNativeNotification,
  type NotifiableThread,
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

const SESSION_DEFAULTS = {
  threadId: "thread-1",
  providerName: null,
  runtimeMode: "full-access",
  updatedAt: "2026-01-01T00:00:00Z",
  lastError: null,
  status: "ready",
  activeTurnId: null,
} as const;

function fakeThread(
  overrides: Omit<Partial<NotifiableThread>, "session"> & {
    session?: Record<string, unknown> | null;
  },
): NotifiableThread {
  const { session: sessionOverrides, ...rest } = overrides;
  return {
    id: "thread-1",
    title: "My thread",
    activities: [],
    ...rest,
    session: sessionOverrides
      ? (Object.assign({}, SESSION_DEFAULTS, sessionOverrides) as NotifiableThread["session"])
      : null,
  } as NotifiableThread;
}

function fakeActivity(
  overrides: Partial<OrchestrationThreadActivity>,
): OrchestrationThreadActivity {
  return {
    id: "act-1",
    tone: "info",
    kind: "task.progress",
    summary: "Doing work",
    payload: null,
    turnId: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as OrchestrationThreadActivity;
}

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

describe("resolveTurnCompletionNotification", () => {
  const previous = { status: "running" as const, activeTurnId: "turn-1" };

  it("returns null when shouldNotify is false", () => {
    const thread = fakeThread({ session: { status: "ready", activeTurnId: null } });
    expect(
      resolveTurnCompletionNotification({
        shouldNotify: false,
        level: NotificationLevel.Normal,
        thread,
        previous,
        lastNotifiedTurnId: undefined,
      }),
    ).toBeNull();
  });

  it("returns null when level is off", () => {
    const thread = fakeThread({ session: { status: "ready", activeTurnId: null } });
    expect(
      resolveTurnCompletionNotification({
        shouldNotify: true,
        level: NotificationLevel.Off,
        thread,
        previous,
        lastNotifiedTurnId: undefined,
      }),
    ).toBeNull();
  });

  it("returns 'Task completed' for a successful turn at normal level", () => {
    const thread = fakeThread({ session: { status: "ready", activeTurnId: null } });
    const result = resolveTurnCompletionNotification({
      shouldNotify: true,
      level: NotificationLevel.Normal,
      thread,
      previous,
      lastNotifiedTurnId: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Task completed");
    expect(result!.turnId).toBe("turn-1");
  });

  it("returns 'Task failed' for an error turn", () => {
    const thread = fakeThread({
      session: { status: "error", activeTurnId: null, lastError: "boom" },
    });
    const result = resolveTurnCompletionNotification({
      shouldNotify: true,
      level: NotificationLevel.Normal,
      thread,
      previous,
      lastNotifiedTurnId: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Task failed");
    expect(result!.body).toBe("boom");
  });

  it("suppresses successful completion at important level", () => {
    const thread = fakeThread({ session: { status: "ready", activeTurnId: null } });
    expect(
      resolveTurnCompletionNotification({
        shouldNotify: true,
        level: NotificationLevel.Important,
        thread,
        previous,
        lastNotifiedTurnId: undefined,
      }),
    ).toBeNull();
  });

  it("still fires for errors at important level", () => {
    const thread = fakeThread({
      session: { status: "error", activeTurnId: null, lastError: "oops" },
    });
    const result = resolveTurnCompletionNotification({
      shouldNotify: true,
      level: NotificationLevel.Important,
      thread,
      previous,
      lastNotifiedTurnId: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Task failed");
  });

  it("skips already-notified turn", () => {
    const thread = fakeThread({ session: { status: "ready", activeTurnId: null } });
    expect(
      resolveTurnCompletionNotification({
        shouldNotify: true,
        level: NotificationLevel.Normal,
        thread,
        previous,
        lastNotifiedTurnId: "turn-1",
      }),
    ).toBeNull();
  });

  it("truncates body longer than 180 characters", () => {
    const longTitle = "A".repeat(200);
    const thread = fakeThread({
      title: longTitle,
      session: { status: "ready", activeTurnId: null },
    });
    const result = resolveTurnCompletionNotification({
      shouldNotify: true,
      level: NotificationLevel.Normal,
      thread,
      previous,
      lastNotifiedTurnId: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.body.length).toBe(180);
    expect(result!.body.endsWith("...")).toBe(true);
  });
});

describe("resolveAttentionNotification", () => {
  it("returns null when shouldNotify is false", () => {
    const thread = fakeThread({
      activities: [fakeActivity({ kind: "approval.requested" })],
    });
    expect(
      resolveAttentionNotification({
        shouldNotify: false,
        level: NotificationLevel.Normal,
        thread,
        lastNotifiedActivityId: undefined,
      }),
    ).toBeNull();
  });

  it("returns null when level is off", () => {
    const thread = fakeThread({
      activities: [fakeActivity({ kind: "approval.requested" })],
    });
    expect(
      resolveAttentionNotification({
        shouldNotify: true,
        level: NotificationLevel.Off,
        thread,
        lastNotifiedActivityId: undefined,
      }),
    ).toBeNull();
  });

  it("fires for approval.requested at normal level", () => {
    const thread = fakeThread({
      activities: [fakeActivity({ id: "a1" as never, kind: "approval.requested" })],
    });
    const result = resolveAttentionNotification({
      shouldNotify: true,
      level: NotificationLevel.Normal,
      thread,
      lastNotifiedActivityId: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Approval required");
    expect(result!.activityId).toBe("a1");
  });

  it("fires for user-input.requested at important level", () => {
    const thread = fakeThread({
      activities: [fakeActivity({ id: "a2" as never, kind: "user-input.requested" })],
    });
    const result = resolveAttentionNotification({
      shouldNotify: true,
      level: NotificationLevel.Important,
      thread,
      lastNotifiedActivityId: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Input required");
  });

  it("ignores task.progress at normal level", () => {
    const thread = fakeThread({
      activities: [fakeActivity({ kind: "task.progress" })],
    });
    expect(
      resolveAttentionNotification({
        shouldNotify: true,
        level: NotificationLevel.Normal,
        thread,
        lastNotifiedActivityId: undefined,
      }),
    ).toBeNull();
  });

  it("fires for task.progress at verbose level", () => {
    const thread = fakeThread({
      activities: [fakeActivity({ id: "a3" as never, kind: "task.progress" })],
    });
    const result = resolveAttentionNotification({
      shouldNotify: true,
      level: NotificationLevel.Verbose,
      thread,
      lastNotifiedActivityId: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBe("Task update");
  });

  it("skips already-notified activity", () => {
    const thread = fakeThread({
      activities: [fakeActivity({ id: "a1" as never, kind: "approval.requested" })],
    });
    expect(
      resolveAttentionNotification({
        shouldNotify: true,
        level: NotificationLevel.Normal,
        thread,
        lastNotifiedActivityId: "a1",
      }),
    ).toBeNull();
  });

  it("picks the latest matching activity", () => {
    const thread = fakeThread({
      activities: [
        fakeActivity({ id: "a1" as never, kind: "approval.requested", summary: "First" }),
        fakeActivity({ id: "a2" as never, kind: "approval.requested", summary: "Second" }),
      ],
    });
    const result = resolveAttentionNotification({
      shouldNotify: true,
      level: NotificationLevel.Normal,
      thread,
      lastNotifiedActivityId: undefined,
    });
    expect(result).not.toBeNull();
    expect(result!.activityId).toBe("a2");
    expect(result!.body).toBe("Second");
  });
});
