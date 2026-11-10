import type { AnyRouter } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../../test/render";
import { RELEASED_COMPLETION_GRACE_MS } from "./ThreadNotificationCoordinator.logic";

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
  snoozedUntil: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingRequestId: "request-1",
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
      ? { id: input.pendingRequestId, kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: input.pendingRequestId, kind: "command", createdAt: SHELL_NOW }
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
    snoozedUntil: input.snoozedUntil ? DateTime.makeUnsafe(input.snoozedUntil) : null,
    snoozedAt: input.snoozedUntil ? SHELL_NOW : null,
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
    expect(state.badge).toHaveBeenLastCalledWith(1);
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    app.changeSettings();
    expect(state.badge).toHaveBeenLastCalledWith(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "notifies again when a new %s request replaces the pending one in the same run",
  async (flag) => {
    await using app = setup();
    app.start();
    state.shells.set("one", shell({ [flag]: true, pendingRequestId: "request-1" }));
    state.shells.set("one", shell({ [flag]: true, pendingRequestId: "request-2" }));
    const title = flag === "hasPendingApprovals" ? "Approval needed" : "Input needed";
    expect(TestNotification.sent.map(({ title }) => title)).toEqual([title, title]);
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

it("stays quiet while a thread is snoozed, until it asks for approval", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  const snoozedUntil = "2999-01-01T00:00:00.000Z";
  const completed = {
    snoozedUntil,
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:00:01.000Z" },
  };
  app.start();
  state.shells.set("one", shell({ snoozedUntil }));
  state.shells.set("one", shell(completed));
  expect(TestNotification.sent).toEqual([]);
  expect(state.sound).not.toHaveBeenCalled();

  state.shells.set("one", shell({ ...completed, snoozedUntil: null }));
  expect(state.sound).not.toHaveBeenCalled();

  state.shells.set("one", shell({ snoozedUntil, hasPendingApprovals: true }));
  expect(TestNotification.sent.map(({ title }) => title)).toEqual(["Approval needed"]);
  expect(state.sound).toHaveBeenCalledWith("input", expect.any(Function));
});

it.each([false, true])(
  "presents one completion when a monitor ends with a final wake (disconnected: %s)",
  async (disconnect) => {
    await using app = setup();
    using _timers = fakeTimers();
    state.mode = "notifications-and-sound";
    app.start();
    const watching = (
      turnId: string,
      turnState: string,
      completedAt: string | null,
      latestRunBackgroundWake: boolean,
      pendingBackgroundTasks: ReadonlyArray<{ taskId: string; kind: "monitor" }>,
    ) => ({
      status: "live",
      snapshot: Option.some({
        threads: [
          {
            ...toV2ThreadShell({
              ...thread,
              latestTurn: { turnId, state: turnState, completedAt },
            }),
            latestRunBackgroundWake,
            pendingBackgroundTasks,
          },
        ],
      }),
    });
    const monitor = [{ taskId: "watch", kind: "monitor" as const }];
    const titles = () => TestNotification.sent.map(({ title }) => title);
    state.shells.set(
      "one",
      watching("turn", "completed", "2026-09-13T07:00:01.000Z", false, monitor),
    );
    expect(titles()).toEqual(["Thread completed"]);

    state.shells.set("one", watching("wake", "running", null, true, monitor));
    state.shells.set(
      "one",
      watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, monitor),
    );
    expect(titles()).toEqual(["Thread completed"]);

    // The adapter drains the roster before the final wake starts.
    state.shells.set("one", watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, []));
    expect(titles()).toEqual(["Thread completed"]);
    if (disconnect) {
      state.shells.set("one", {
        ...watching("wake", "completed", "2026-09-13T07:00:09.000Z", true, []),
        status: "cached",
      });
      vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
      expect(titles()).toEqual(["Thread completed"]);
    }

    state.shells.set("one", watching("final", "running", null, false, []));
    vi.advanceTimersByTime(RELEASED_COMPLETION_GRACE_MS);
    state.shells.set("one", watching("final", "completed", "2026-09-13T07:00:11.000Z", false, []));
    expect(titles()).toEqual(["Thread completed", "Thread completed"]);
    expect(state.sound).toHaveBeenCalledTimes(2);
  },
);

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
