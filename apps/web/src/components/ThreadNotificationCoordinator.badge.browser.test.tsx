import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  environmentIds: ["one", "two"],
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => ({})) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast as never } };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => state.environmentIds) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((
    select: (settings: { notificationMode: string; inAppNotificationsEnabled: boolean }) => unknown,
  ) => select({ notificationMode: state.mode, inAppNotificationsEnabled: state.inApp })) as never,
  getClientSettings: (() => ({ notificationMode: state.mode })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { ThreadNotificationCoordinator } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
state.shells = { set: (id, value) => registry.set(shellAtom(id), value) };

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

const thread = {
  id: "thread",
  title: "Test thread",
  archivedAt: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
let root: Root;
let focused = false;
let visibility = "visible";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
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
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function shell(overrides: Partial<typeof thread> = {}, ...others: Partial<typeof thread>[]) {
  return {
    status: "live",
    snapshot: Option.some({
      threads: [overrides, ...others].map((override) =>
        toV2ThreadShell({ ...thread, ...override }),
      ),
    }),
  };
}
function complete(environment = "one", completedAt = "2026-09-13T08:00:00Z") {
  state.shells.set(
    environment,
    shell({ latestTurn: { turnId: "turn", state: "completed", completedAt } }),
  );
}
async function render() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <ThreadNotificationCoordinator />
      </RegistryContext.Provider>,
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  registry = AtomRegistry.make();
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
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility as DocumentVisibilityState,
  );
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  delete window.desktopBridge;
  registry.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("uses bounded tags across threads and environments, replaces repeat alerts, and clears on focus", async () => {
  const environmentId = "fd6fff30-f90b-4ee7-9812-4cf497791b90";
  const otherEnvironmentId = "25b62992-b996-4ee3-8d82-d988840e45c1";
  const threadId = "a8395a98-a186-4fe7-9d4c-fb8ba63b7588";
  const otherThreadId = "257598ad-ae4f-4422-a073-e03f4b4f5f0d";
  const completed = (id: string, completedAt = "2026-09-13T08:00:00Z") => ({
    id,
    latestTurn: { turnId: "turn", state: "completed", completedAt },
  });
  state.environmentIds = [environmentId, otherEnvironmentId];
  state.shells.set(environmentId, shell({ id: threadId }, { id: otherThreadId }));
  state.shells.set(otherEnvironmentId, shell({ id: threadId }));
  await render();
  state.shells.set(environmentId, shell(completed(threadId), { id: otherThreadId }));
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  state.shells.set(environmentId, shell(completed(threadId), completed(otherThreadId)));
  state.shells.set(otherEnvironmentId, shell(completed(threadId)));
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(3);
  state.shells.set(
    environmentId,
    shell(completed(threadId, "2026-09-13T08:01:00Z"), completed(otherThreadId)),
  );
  await render();
  expect(state.badge).toHaveBeenLastCalledWith(3);
  expect(TestNotification.sent).toHaveLength(4);
  const [first, otherThread, otherEnvironment, replacement] = TestNotification.sent;
  for (const notification of TestNotification.sent) {
    expect(notification.tag).toMatch(/^[0-9a-f]{16}$/);
  }
  expect(new Set([first!.tag, otherThread!.tag, otherEnvironment!.tag]).size).toBe(3);
  expect(replacement!.tag).toBe(first!.tag);
  expect(first!.close).toHaveBeenCalledOnce();
  expect(otherThread!.close).not.toHaveBeenCalled();
  expect(otherEnvironment!.close).not.toHaveBeenCalled();
  expect(replacement!.close).not.toHaveBeenCalled();
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(state.badge).toHaveBeenLastCalledWith(0);
  expect(
    TestNotification.sent.every((notification) => notification.close.mock.calls.length > 0),
  ).toBe(true);
  focused = false;
  state.shells.set(otherEnvironmentId, shell(completed(threadId, "2026-09-13T08:02:00Z")));
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
  await act(async () => root.unmount());
  root = createRoot(document.createElement("div"));
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
          archivedAt: "2026-09-13T08:00:00Z",
          hasPendingApprovals: true,
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
    state.shells.set("one", shell({ [flag]: true }));
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
  state.shells.set("one", shell({ latestTurn: { ...thread.latestTurn, state: "error" } }));
  await render();
  expect(TestNotification.sent[0]?.title).toBe("Thread failed");
  expect(state.badge).toHaveBeenLastCalledWith(1);
  expect(state.toast).not.toHaveBeenCalled();
});
