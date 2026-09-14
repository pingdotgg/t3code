import { makeThreadFixture } from "../test-fixtures";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  shells: new Map(),
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  environmentIds: ["one", "two"],
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (id: string) => state.shells.get(id) }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({}),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast } }));
vi.mock("../state/shell", () => ({ environmentShell: { stateValueAtom: (id: string) => id } }));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: state.environmentIds.map((environmentId) => ({ environmentId })),
  }),
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: { notificationMode: string; inAppNotificationsEnabled: boolean }) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

const thread: OrchestrationV2ThreadShell = {
  ...makeThreadFixture({ id: ThreadId.make("thread"), title: "Test thread" }).source,
  latestRunId: RunId.make("run"),
  status: "running",
  latestRunCompletedAt: null,
};
let renderer: ReactTestRenderer | undefined;
let focused = false;
let visibility = "visible";

function shell(overrides: Partial<typeof thread> = {}) {
  return { status: "live", snapshot: Option.some({ threads: [{ ...thread, ...overrides }] }) };
}
function complete(environment = "one", completedAt = "2026-09-13T08:00:00Z") {
  state.shells.set(
    environment,
    shell({ status: "completed", latestRunCompletedAt: DateTime.makeUnsafe(completedAt) }),
  );
}
async function render() {
  await act(async () => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.mode = "notifications";
  state.inApp = false;
  state.environmentIds = ["one", "two"];
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { focus: vi.fn() }));
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      hasFocus: () => focused,
      get visibilityState() {
        return visibility;
      },
    }),
  );
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("counts notifying threads across environments, replaces repeat alerts, and clears on focus", async () => {
  await render();
  complete();
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  complete("one", "2026-09-13T08:01:00Z");
  complete("two");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2);
  expect(TestNotification.sent[0]!.close).toHaveBeenCalledOnce();
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(state.badge).toHaveBeenLastCalledWith(0);
  expect(
    TestNotification.sent.every((notification) => notification.close.mock.calls.length > 0),
  ).toBe(true);
  focused = false;
  complete("two", "2026-09-13T08:02:00Z");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
});

it("does not badge old completions on first load or reconnect", async () => {
  complete();
  await render();
  state.shells.set("one", { status: "connecting", snapshot: Option.none() });
  await render();
  complete("one", "2026-09-13T08:01:00Z");
  await render();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
});

it("removes alerts only from environments that leave the client", async () => {
  await render();
  complete("one");
  complete("two");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(2);
  const [removed, retained] = TestNotification.sent;
  state.environmentIds = ["two"];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  expect(removed!.close).toHaveBeenCalledOnce();
  expect(retained!.close).not.toHaveBeenCalled();
  await render();
  expect(removed!.close).toHaveBeenCalledOnce();
  state.environmentIds = [];
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(0);
  expect(retained!.close).toHaveBeenCalledOnce();
});

it("starts a fresh count after another native app window gains focus", async () => {
  let clear: (() => void) | undefined;
  const unsubscribe = vi.fn();
  Object.assign(window, {
    desktopBridge: {
      onNotificationBadgeClear: (listener: () => void) => {
        clear = listener;
        return unsubscribe;
      },
    },
  });
  await render();
  complete();
  await render();
  clear!();
  expect(state.badge).toHaveBeenLastCalledWith(0);
  complete("two");
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(state.badge).toHaveBeenLastCalledWith(0);
});

it.each(["off", "sound", "focused", "denied", "archived"])(
  "does not show visual alerts when %s",
  async (condition) => {
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "focused") focused = true;
    if (condition === "denied") TestNotification.permission = "denied";
    await render();
    complete();
    if (condition === "archived")
      state.shells.set(
        "one",
        shell({
          archivedAt: DateTime.makeUnsafe("2026-09-13T08:00:00Z"),
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request"),
            kind: "command",
            createdAt: thread.createdAt,
          },
        }),
      );
    await render();
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when notifications are disabled",
  async (flag) => {
    await render();
    state.shells.set(
      "one",
      shell({
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request"),
          kind: flag === "hasPendingUserInput" ? "user_input" : "command",
          createdAt: thread.createdAt,
        },
      }),
    );
    await render();
    expect(state.badge).toHaveBeenLastCalledWith(1);
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    await render();
    expect(state.badge).toHaveBeenLastCalledWith(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

it("shows in-app alerts without adding a badge while focused", async () => {
  state.inApp = true;
  focused = true;
  await render();
  complete();
  await render();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.badge.mock.calls.every(([count]) => count === 0)).toBe(true);
});

it("badges background failures with in-app notifications enabled", async () => {
  state.inApp = true;
  await render();
  state.shells.set("one", shell({ status: "failed" }));
  await render();
  expect(TestNotification.sent[0]?.title).toBe("Thread failed");
  expect(state.badge).toHaveBeenLastCalledWith(1);
  expect(state.toast).not.toHaveBeenCalled();
});
