import type { AnyRouter } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
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
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      pendingSubagentRequestsAtom: (() => noRequestsAtom) as never,
      get delegatedUnderParentAtom() {
        return noDelegatedAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
    notificationBadgeColor: "#e5484d",
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);
const noRequestsAtom = Atom.make(new Map());
const noDelegatedAtom = Atom.make<ReadonlySet<string>>(new Set<string>());
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
  lastVisitedAt: null as string | null,
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
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
    lastVisitedAt: input.lastVisitedAt ? DateTime.makeUnsafe(input.lastVisitedAt) : null,
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
// The mocked modules read `state` and the focus flags, so every test resets them before
// starting the service.
function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.settingsListeners.clear();
  registry.set(environmentIdsAtom, ["one", "two"]);
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility as DocumentVisibilityState),
  );
  const router = {
    state: { matches: [{ params: {} }] },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  return {
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
    changeSettings: () => {
      for (const listener of state.settingsListeners) listener();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when notifications are disabled",
  async (flag) => {
    await using app = setup();
    app.start();
    state.shells.set("one", shell({ [flag]: true }));
    expect(state.badge).toHaveBeenLastCalledWith(1, "#e5484d");
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    app.changeSettings();
    expect(state.badge).toHaveBeenLastCalledWith(0, "#e5484d");
    expect(notification.close).toHaveBeenCalled();
  },
);

it("presents completion notifications and sound as soon as the shell completes", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  app.start();
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:00:01.000Z" },
    }),
  );
  expect(TestNotification.sent.map((sent) => sent.title)).toEqual(["Thread completed"]);
  expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
});

it("restores unread counts, acknowledges only visited completions, and retains open requests", async () => {
  await using app = setup();
  const done = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:00:01.000Z" },
  };
  state.shells.set("one", shell({ ...done, id: "a" }, { ...done, id: "b" }));
  state.shells.set("two", shell({ hasPendingUserInput: true }));
  app.start();
  expect(state.badge).toHaveBeenLastCalledWith(3, "#e5484d");
  expect(TestNotification.sent).toHaveLength(0);
  focused = true;
  window.dispatchEvent(new Event("focus"));
  expect(state.badge).toHaveBeenLastCalledWith(3, "#e5484d");
  state.shells.set(
    "one",
    shell({ ...done, id: "a", lastVisitedAt: "2026-09-13T07:00:02.000Z" }, { ...done, id: "b" }),
  );
  expect(state.badge).toHaveBeenLastCalledWith(2, "#e5484d");
  state.shells.set(
    "two",
    shell({ hasPendingUserInput: true, lastVisitedAt: "2026-09-13T07:00:02.000Z" }),
  );
  expect(state.badge).toHaveBeenLastCalledWith(2, "#e5484d");
  state.shells.set("two", shell());
  expect(state.badge).toHaveBeenLastCalledWith(1, "#e5484d");
  state.shells.set("one", shell({ ...done, id: "b", archivedAt: "2026-09-13T07:00:03.000Z" }));
  expect(state.badge).toHaveBeenLastCalledWith(0, "#e5484d");
});

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "notifies for offline completion and %s once across reconnects",
  async (flag) => {
    await using app = setup();
    const asking = { id: "asking", hasPendingApprovals: true };
    const offline = { id: "offline", [flag]: true };
    const done = {
      id: "done",
      latestTurn: {
        turnId: "done-turn",
        state: "completed",
        completedAt: "2026-09-13T07:00:00.000Z",
      },
    };
    state.shells.set("one", shell({ id: "working" }, { id: "asking" }, { id: "offline" }, done));
    app.start();
    state.shells.set("one", shell({ id: "working" }, asking, { id: "offline" }, done));
    state.shells.set("one", {
      ...shell({ id: "working" }, asking, { id: "offline" }, done),
      status: "cached",
    });

    const completed = {
      id: "working",
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:05:00.000Z" },
    };
    state.shells.set("one", {
      ...shell(completed, asking, offline, done),
      status: "synchronizing",
    });
    state.shells.set("one", shell(completed, asking, offline, done));

    expect(TestNotification.sent.map(({ title }) => title)).toEqual([
      "Approval needed",
      "Thread completed",
      flag === "hasPendingApprovals" ? "Approval needed" : "Input needed",
    ]);
    state.shells.set("one", { ...shell(completed, asking, offline, done), status: "cached" });
    state.shells.set("one", shell(completed, asking, offline, done));
    expect(TestNotification.sent.map(({ title }) => title)).toEqual([
      "Approval needed",
      "Thread completed",
      flag === "hasPendingApprovals" ? "Approval needed" : "Input needed",
    ]);
  },
);

it.each([false, true])(
  "does not replay a notified completion after reconnect (continued: %s)",
  async (continued) => {
    await using app = setup();
    app.start();
    const completed = shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:05:00.000Z" },
    });
    state.shells.set("one", completed);
    state.shells.set("one", { ...completed, status: "cached" });
    expect(TestNotification.sent.map(({ title }) => title)).toEqual(["Thread completed"]);
    state.shells.set("one", continued ? shell() : completed);
    expect(TestNotification.sent.map(({ title }) => title)).toEqual(["Thread completed"]);
  },
);
