import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError
        ? "failed"
        : "running",
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    status: state.live ? "live" : "disconnected",
    snapshot: Option.some({ threads: [mockThreadShell()] }),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  useParams: () => state.active,
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: (
    select: (
      settings: Pick<ClientSettings, "notificationMode" | "inAppNotificationsEnabled">,
    ) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp }),
  getClientSettings: () => ({ notificationMode: state.mode }),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: "env-1" }] }),
}));
vi.mock("../state/shell", () => ({
  environmentShell: { stateValueAtom: vi.fn() },
}));
vi.mock("../threadNotifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../threadNotifications")>()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: state.add, close: state.close },
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let renderer: ReactTestRenderer | undefined;

async function render() {
  await act(() => {
    if (renderer) renderer.update(<ThreadNotificationCoordinator />);
    else renderer = create(<ThreadNotificationCoordinator />);
  });
}

async function complete() {
  state.completedAt = "2026-09-13T10:00:00.000Z";
  await render();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", {
    get visibilityState() {
      return state.visible;
    },
    hasFocus: () => state.focused,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("thread notifications", () => {
  it("alerts once with system alerts off and opens the completed thread", async () => {
    await render();
    await complete();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    const toast = state.add.mock.calls[0]?.[0];
    expect(toast?.title).toBe("Thread completed");
    expect(toast?.description).toBe("Fix the login form");
    toast?.actionProps.onClick();
    expect(state.close).toHaveBeenCalledWith("toast-1");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-1", threadId: "thread-1" },
    });
    expect(state.notification).not.toHaveBeenCalled();
  });

  it.each(["active", "blurred", "hidden", "archived", "disabled"])(
    "does not show a completion toast for %s threads",
    async (condition) => {
      await render();
      if (condition === "active") state.active.threadId = "thread-1";
      if (condition === "blurred") state.focused = false;
      if (condition === "hidden") state.visible = "hidden";
      if (condition === "archived") state.archivedAt = "2026-09-13T09:00:00.000Z";
      if (condition === "disabled") state.inApp = false;
      await complete();
      expect(state.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["input", "Input needed"],
    ["approval", "Approval needed"],
    ["sessionError", "Thread failed"],
    ["turnError", "Thread failed"],
  ] as const)("uses the same %s event for in-app and desktop alerts", async (event, title) => {
    state.mode = "notifications-and-sound";
    await render();
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(expect.objectContaining({ title }));
    expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
    expect(state.notification).not.toHaveBeenCalled();

    state[event] = false;
    await render();
    state.focused = false;
    state[event] = true;
    await render();
    await render();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(title, {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });

  it("keeps background desktop alerts when in-app notifications are disabled", async () => {
    state.focused = false;
    state.inApp = false;
    state.mode = "notifications";
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledTimes(1);
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("does not replay a completion when opting in from all alerts off", async () => {
    state.inApp = false;
    await render();
    await complete();
    state.inApp = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("compares the environment as well as the thread", async () => {
    state.active = { environmentId: "env-2", threadId: "thread-1" };
    await render();
    await complete();
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it("does not replay completed threads on first load or reconnect", async () => {
    await complete();
    state.live = false;
    await render();
    state.live = true;
    await render();
    expect(state.add).not.toHaveBeenCalled();
  });

  it("keeps sound but replaces the system popup when showing a toast", async () => {
    state.mode = "notifications-and-sound";
    await render();
    await complete();
    expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("keeps system alerts when the app is in the background", async () => {
    state.mode = "notifications";
    state.focused = false;
    await render();
    await complete();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.notification).toHaveBeenCalledWith("Thread completed", {
      body: "Fix the login form",
      tag: "env-1:thread-1",
      silent: true,
    });
  });
});
