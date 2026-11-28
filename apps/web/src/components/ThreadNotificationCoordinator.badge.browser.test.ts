import type { AnyRouter } from "@tanstack/react-router";
import {
  EMPTY_TEAM_ENVIRONMENT_STATE,
  type TeamEnvironmentState,
} from "@t3tools/client-runtime/team";
import {
  EnvironmentId,
  ProjectId,
  TeamId,
  TeamMemberId,
  TeamViewId,
  ThreadId,
  type TeamMember,
  type TeamNotificationSoundPreset,
  type TeamPseudo,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../../test/render";
import { RELEASED_COMPLETION_GRACE_MS } from "./ThreadNotificationCoordinator.logic";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  teamNotificationSounds: {} as Record<string, TeamNotificationSoundPreset>,
  toast: vi.fn(),
  closeToast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  teamStates: null as unknown as {
    set: (id: string, value: TeamEnvironmentState) => void;
    setRaw: (id: string, value: AsyncResult.AsyncResult<TeamEnvironmentState, unknown>) => void;
  },
  navigate: vi.fn(),
  sound: vi.fn(),
  unlock: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: state.toast as never,
      close: state.closeToast as never,
    },
  };
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
vi.mock(import("../state/team"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    teamEnvironment: {
      ...actual.teamEnvironment,
      state: ((id: string) => teamStateAtom(id)) as never,
    },
    readTeamEnvironmentStateFromRegistry: ((reg: AtomRegistry.AtomRegistry, id: EnvironmentId) => {
      const result = reg.get(teamStateAtom(id));
      return result._tag === "Success" ? result.value : null;
    }) as never,
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
    teamNotificationSounds: state.teamNotificationSounds,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: state.unlock,
  setNotificationBadge: state.badge,
}));

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const teamStateAtom = Atom.family((_id: string) =>
  Atom.make<AsyncResult.AsyncResult<TeamEnvironmentState, unknown>>(
    AsyncResult.success(EMPTY_TEAM_ENVIRONMENT_STATE),
  ),
);
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);
const noRequestsAtom = Atom.make(new Map());
const noDelegatedAtom = Atom.make<ReadonlySet<string>>(new Set<string>());
state.shells = { set: (id, value) => registry.set(shellAtom(id), value) };
state.teamStates = {
  set: (id, value) => registry.set(teamStateAtom(id), AsyncResult.success(value)),
  setRaw: (id, value) => registry.set(teamStateAtom(id), value),
};

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
  state.teamNotificationSounds = {};
  state.settingsListeners.clear();
  registry.set(environmentIdsAtom, ["one", "two"]);
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  state.teamStates.set("one", EMPTY_TEAM_ENVIRONMENT_STATE);
  state.teamStates.set("two", EMPTY_TEAM_ENVIRONMENT_STATE);
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
  const routeListeners = new Set<() => void>();
  const route = { params: {} as Record<string, string> };
  const router = {
    state: { matches: [route] },
    navigate: state.navigate,
    subscribe: (_event: string, listener: () => void) => {
      routeListeners.add(listener);
      return () => routeListeners.delete(listener);
    },
  } as unknown as AnyRouter;
  return {
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
    openThread: (environmentId: string, threadId: string) => {
      route.params = { environmentId, threadId };
      for (const listener of routeListeners) listener();
    },
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
  "notifies once per %s request, not again as queued runs start behind it",
  async (flag) => {
    await using app = setup();
    app.start();
    const waiting = (turnId: string, pendingRequestId: string) =>
      shell({
        [flag]: true,
        pendingRequestId,
        latestTurn: { turnId, state: "running", completedAt: null },
      });
    state.shells.set("one", waiting("turn-1", "request-1"));
    state.shells.set("one", waiting("turn-2", "request-1"));
    state.shells.set("one", waiting("turn-2", "request-2"));
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

it.each([
  { client: "desktop app", when: "at startup", bridge: {}, beforeGesture: 1 },
  { client: "browser", when: "on the first gesture", bridge: undefined, beforeGesture: 0 },
])("readies notification sound in the $client $when", async ({ bridge, beforeGesture }) => {
  await using app = setup();
  using _bridge = stubGlobal("desktopBridge", bridge);
  state.mode = "sound";
  app.start();
  expect(state.unlock).toHaveBeenCalledTimes(beforeGesture);
  document.dispatchEvent(new Event("pointerdown"));
  expect(state.unlock).toHaveBeenCalledTimes(beforeGesture + 1);
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

it("opening a thread or removing its environment closes only its in-app toasts, and disabling notifications closes the rest", async () => {
  await using app = setup();
  state.inApp = true;
  focused = true;
  state.toast
    .mockReturnValueOnce("one-completed")
    .mockReturnValueOnce("one-approval")
    .mockReturnValueOnce("one-other")
    .mockReturnValueOnce("two-completed");
  state.shells.set("one", shell({}, { id: "other" }));
  app.start();
  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00Z" },
  };
  state.shells.set("one", shell(completed, { id: "other" }));
  state.shells.set("one", shell({ ...completed, hasPendingApprovals: true }, { id: "other" }));
  state.shells.set(
    "one",
    shell({ ...completed, hasPendingApprovals: true }, { ...completed, id: "other" }),
  );
  state.shells.set("two", shell(completed));
  expect(state.toast).toHaveBeenCalledTimes(4);

  app.openThread("one", "thread");
  expect(state.closeToast.mock.calls).toEqual([["one-completed"], ["one-approval"]]);

  app.setEnvironmentIds(["one"]);
  expect(state.closeToast.mock.calls.slice(2)).toEqual([["two-completed"]]);

  state.mode = "off";
  state.inApp = false;
  app.changeSettings();
  expect(state.closeToast.mock.calls.slice(3)).toEqual([["one-other"]]);
});

it("gates team thread notifications by creator, follow state, and completing turn author, and clears pending notifications on unfollow", async () => {
  await using app = setup();
  const teamId = TeamId.make("team-1");
  const viewId = TeamViewId.make("view-1");
  const aliceId = TeamMemberId.make("member-alice");
  const bobId = TeamMemberId.make("member-bob");
  const threadId = ThreadId.make("thread");
  const alice: TeamMember = {
    id: aliceId,
    teamId,
    pseudo: "alice" as TeamPseudo,
    role: "owner",
    status: "active",
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const bob: TeamMember = {
    id: bobId,
    teamId,
    pseudo: "bob" as TeamPseudo,
    role: "regular",
    status: "active",
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const attribution = {
    threadId,
    teamId,
    creatorMemberId: aliceId,
    creatorPseudo: alice.pseudo,
    viewId,
    locked: false,
    lockedByMemberId: null,
    createdAt: "2026-09-13T07:00:00.000Z",
  };
  const aliceRun1 = {
    turnId: "run-1",
    threadId,
    authorMemberId: aliceId,
    authorPseudo: alice.pseudo,
    createdAt: "2026-09-13T07:00:30.000Z",
  };
  const baseTeamState: TeamEnvironmentState = {
    team: {
      id: teamId,
      name: "Core",
      defaultViewId: viewId,
      createdAt: "2026-09-13T07:00:00.000Z",
      updatedAt: "2026-09-13T07:00:00.000Z",
    },
    currentMember: bob,
    members: [alice, bob],
    views: [],
    invites: [],
    threadAttributions: [attribution],
    followedThreadIds: new Set(),
    snoozedByThreadId: new Map(),
    latestTurnByThreadId: new Map([[threadId, aliceRun1]]),
    turnAuthorByTurnId: new Map([[aliceRun1.turnId, aliceRun1]]),
    memberById: new Map([
      [aliceId, alice],
      [bobId, bob],
    ]),
    viewById: new Map(),
    attributionByThreadId: new Map([[threadId, attribution]]),
    teamProjects: [],
    projectAssignmentByProjectId: new Map(),
    projectAssignmentByRepoKey: new Map(),
    environments: [],
    environmentById: new Map(),
    threadNotesByThreadId: new Map(),
    providers: [],
    skills: [],
    preprompts: [],
    assetsRevision: 0,
    myGitHubIdentity: null,
    automationGitHubIdentity: null,
    githubAppConfig: null,
    scheduledTaskMetas: [],
    scheduledTaskMetaByTaskId: new Map(),
    queuedMessageNotifications: [],
  };

  state.teamStates.set("one", baseTeamState);
  app.start();

  // 1. Alice's turn completes while Bob is not following -> 0 notifications.
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "run-1", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  expect(TestNotification.sent).toHaveLength(0);

  // 2. Bob follows Alice's thread -> Alice's next turn notifies with pseudo-prefixed body.
  state.teamStates.set("one", {
    ...baseTeamState,
    followedThreadIds: new Set([threadId]),
  });
  state.shells.set(
    "one",
    shell({ latestTurn: { turnId: "run-2", state: "running", completedAt: null } }),
  );
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "run-2", state: "completed", completedAt: "2026-09-13T07:02:00.000Z" },
    }),
  );
  expect(TestNotification.sent).toHaveLength(1);
  expect(TestNotification.sent[0]?.options.body).toBe("alice: Test thread");
  expect(state.badge).toHaveBeenLastCalledWith(1);

  state.teamStates.set("one", {
    ...baseTeamState,
    followedThreadIds: new Set([threadId]),
    snoozedByThreadId: new Map([
      [
        threadId,
        {
          threadId,
          snoozedAt: "2026-09-13T07:02:01.000Z",
          snoozedUntil: "2099-09-13T08:02:01.000Z",
          lastSnoozeWakeAt: null,
        },
      ],
    ]),
    queuedMessageNotifications: [
      {
        threadId,
        queuedRunId: "queued-during-snooze",
        senderMemberId: aliceId,
        senderPseudo: alice.pseudo,
        recipientMemberIds: [bobId],
        messagePreview: "New message",
        createdAt: "2026-09-13T07:02:30.000Z",
      },
    ],
  });
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "run-snoozed", state: "running", completedAt: null },
      hasPendingApprovals: true,
    }),
  );
  state.shells.set(
    "one",
    shell({
      latestTurn: {
        turnId: "run-snoozed",
        state: "completed",
        completedAt: "2026-09-13T07:02:59.000Z",
      },
    }),
  );
  expect(TestNotification.sent).toHaveLength(1);

  // 3. Bob unfollows while the notification is pending -> pending notification closes & badge resets.
  state.teamStates.set("one", baseTeamState);
  expect(TestNotification.sent[0]?.close).toHaveBeenCalled();
  expect(state.badge).toHaveBeenLastCalledWith(0);

  // 4. Bob authors his own turn on Alice's unfollowed thread -> notifies Bob when it completes.
  const bobRun3 = {
    turnId: "run-3",
    threadId,
    authorMemberId: bobId,
    authorPseudo: bob.pseudo,
    createdAt: "2026-09-13T07:02:30.000Z",
  };
  state.teamStates.set("one", {
    ...baseTeamState,
    latestTurnByThreadId: new Map([[threadId, bobRun3]]),
    turnAuthorByTurnId: new Map([
      [aliceRun1.turnId, aliceRun1],
      [bobRun3.turnId, bobRun3],
    ]),
  });
  state.shells.set(
    "one",
    shell({ latestTurn: { turnId: "run-3", state: "running", completedAt: null } }),
  );
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "run-3", state: "completed", completedAt: "2026-09-13T07:03:00.000Z" },
    }),
  );
  expect(TestNotification.sent).toHaveLength(2);
  expect(TestNotification.sent[1]?.options.body).toBe("alice: Test thread");
});

it("defers notifications and sound across team stream races without leaking colleague alerts or dropping own turns", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  const teamId = TeamId.make("team-race");
  const viewId = TeamViewId.make("view-race");
  const aliceId = TeamMemberId.make("member-alice-race");
  const bobId = TeamMemberId.make("member-bob-race");
  const threadId = ThreadId.make("thread");
  const alice: TeamMember = {
    id: aliceId,
    teamId,
    pseudo: "alice" as TeamPseudo,
    role: "owner",
    status: "active",
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const bob: TeamMember = {
    id: bobId,
    teamId,
    pseudo: "bob" as TeamPseudo,
    role: "regular",
    status: "active",
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const attribution = {
    threadId,
    teamId,
    creatorMemberId: aliceId,
    creatorPseudo: alice.pseudo,
    viewId,
    locked: false,
    lockedByMemberId: null,
    createdAt: "2026-09-13T07:00:00.000Z",
  };
  const aliceRun1 = {
    turnId: "run-race-alice",
    threadId,
    authorMemberId: aliceId,
    authorPseudo: alice.pseudo,
    createdAt: "2026-09-13T07:00:30.000Z",
  };
  const teamState: TeamEnvironmentState = {
    team: {
      id: teamId,
      name: "Race Team",
      defaultViewId: viewId,
      createdAt: "2026-09-13T07:00:00.000Z",
      updatedAt: "2026-09-13T07:00:00.000Z",
    },
    currentMember: bob,
    members: [alice, bob],
    views: [],
    invites: [],
    threadAttributions: [attribution],
    followedThreadIds: new Set(),
    snoozedByThreadId: new Map(),
    latestTurnByThreadId: new Map([[threadId, aliceRun1]]),
    turnAuthorByTurnId: new Map([[aliceRun1.turnId, aliceRun1]]),
    memberById: new Map([
      [aliceId, alice],
      [bobId, bob],
    ]),
    viewById: new Map(),
    attributionByThreadId: new Map([[threadId, attribution]]),
    teamProjects: [],
    projectAssignmentByProjectId: new Map(),
    projectAssignmentByRepoKey: new Map(),
    environments: [],
    environmentById: new Map(),
    threadNotesByThreadId: new Map(),
    providers: [],
    skills: [],
    preprompts: [],
    assetsRevision: 0,
    myGitHubIdentity: null,
    automationGitHubIdentity: null,
    githubAppConfig: null,
    scheduledTaskMetas: [],
    scheduledTaskMetaByTaskId: new Map(),
    queuedMessageNotifications: [],
  };

  // Race A: Shell completes while team metadata is still loading -> must NOT notify or play sound.
  state.teamStates.setRaw("one", AsyncResult.initial(true));
  app.start();
  state.shells.set(
    "one",
    shell({
      latestTurn: {
        turnId: "run-race-alice",
        state: "completed",
        completedAt: "2026-09-13T07:01:00.000Z",
      },
    }),
  );
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.sound).not.toHaveBeenCalled();

  // Team metadata arrives showing this is Alice's unfollowed thread -> stays completely silent.
  state.teamStates.set("one", teamState);
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.sound).not.toHaveBeenCalled();

  // Race B: Bob authors a turn on Alice's unfollowed thread; shell completes BEFORE turnAttributed lands.
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "run-race-bob", state: "running", completedAt: null },
    }),
  );
  state.shells.set(
    "one",
    shell({
      latestTurn: {
        turnId: "run-race-bob",
        state: "completed",
        completedAt: "2026-09-13T07:02:00.000Z",
      },
    }),
  );
  // Initially deferred until turnAttributed arrives.
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.sound).not.toHaveBeenCalled();

  // Once turnAttributed lands confirming Bob authored run-race-bob, the deferred notification & sound fire!
  const bobRun = {
    turnId: "run-race-bob",
    threadId,
    authorMemberId: bobId,
    authorPseudo: bob.pseudo,
    createdAt: "2026-09-13T07:01:55.000Z",
  };
  state.teamStates.set("one", {
    ...teamState,
    latestTurnByThreadId: new Map([[threadId, bobRun]]),
    turnAuthorByTurnId: new Map([
      [aliceRun1.turnId, aliceRun1],
      [bobRun.turnId, bobRun],
    ]),
  });
  expect(TestNotification.sent).toHaveLength(1);
  expect(TestNotification.sent[0]?.options.body).toBe("alice: Test thread");
  expect(state.sound).toHaveBeenCalledTimes(1);

  // Race C: An approval request on run-race-approval is deferred waiting for turnAttributed,
  // then resolves on the same run before attribution arrives -> late attribution must NOT fire a stale alert.
  state.shells.set(
    "one",
    shell({
      hasPendingApprovals: true,
      pendingRequestId: "req-resolved-before-attr",
      latestTurn: { turnId: "run-race-approval", state: "running", completedAt: null },
    }),
  );
  expect(TestNotification.sent).toHaveLength(1);

  // Approval is answered while run-race-approval keeps running.
  state.shells.set(
    "one",
    shell({
      hasPendingApprovals: false,
      pendingRequestId: "req-resolved-before-attr",
      latestTurn: { turnId: "run-race-approval", state: "running", completedAt: null },
    }),
  );

  // Late turnAttributed lands confirming Bob authored run-race-approval -> still 0 new notifications or sounds.
  const bobApprovalRun = {
    turnId: "run-race-approval",
    threadId,
    authorMemberId: bobId,
    authorPseudo: bob.pseudo,
    createdAt: "2026-09-13T07:02:30.000Z",
  };
  state.teamStates.set("one", {
    ...teamState,
    latestTurnByThreadId: new Map([[threadId, bobApprovalRun]]),
    turnAuthorByTurnId: new Map([
      [aliceRun1.turnId, aliceRun1],
      [bobRun.turnId, bobRun],
      [bobApprovalRun.turnId, bobApprovalRun],
    ]),
  });
  expect(TestNotification.sent).toHaveLength(1);
  expect(state.sound).toHaveBeenCalledTimes(1);
});

it("notifies creator and active turn author on queued messages without duplicating or silencing on queued turn attribution", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  const teamId = TeamId.make("team-queue-notif");
  const viewId = TeamViewId.make("view-queue-notif");
  const aliceId = TeamMemberId.make("member-alice-q");
  const bobId = TeamMemberId.make("member-bob-q");
  const charlieId = TeamMemberId.make("member-charlie-q");
  const threadId = ThreadId.make("thread");
  const alice: TeamMember = {
    id: aliceId,
    teamId,
    pseudo: "alice" as TeamPseudo,
    role: "owner",
    status: "active",
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const bob: TeamMember = {
    id: bobId,
    teamId,
    pseudo: "bob" as TeamPseudo,
    role: "regular",
    status: "active",
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const charlie: TeamMember = {
    id: charlieId,
    teamId,
    pseudo: "charlie" as TeamPseudo,
    role: "modo",
    status: "active",
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const attribution = {
    threadId,
    teamId,
    creatorMemberId: aliceId,
    creatorPseudo: alice.pseudo,
    viewId,
    locked: false,
    lockedByMemberId: null,
    createdAt: "2026-09-13T07:00:00.000Z",
  };
  const baseTeamState: TeamEnvironmentState = {
    ...EMPTY_TEAM_ENVIRONMENT_STATE,
    team: {
      id: teamId,
      name: "Queue Team",
      defaultViewId: viewId,
      createdAt: "2026-09-13T07:00:00.000Z",
      updatedAt: "2026-09-13T07:00:00.000Z",
    },
    // Bob is the active turn author on Alice's unfollowed thread.
    currentMember: bob,
    members: [alice, bob, charlie],
    threadAttributions: [attribution],
    memberById: new Map([
      [aliceId, alice],
      [bobId, bob],
      [charlieId, charlie],
    ]),
    attributionByThreadId: new Map([[threadId, attribution]]),
  };

  state.teamStates.set("one", baseTeamState);
  app.start();
  state.shells.set(
    "one",
    shell({
      title: "Deploy pipeline",
      latestTurn: { turnId: "run-bob-active", state: "running", completedAt: null },
    }),
  );

  // Charlie queues a message while Bob's turn is running -> Bob (active turn author) receives notification!
  const queuedNotification = {
    threadId,
    queuedRunId: "run-charlie-queued-1" as never,
    senderMemberId: charlieId,
    senderPseudo: "charlie" as never,
    recipientMemberIds: [aliceId, bobId],
    messagePreview: "Wait for smoke tests",
    createdAt: "2026-09-13T07:01:00.000Z",
  };
  state.teamStates.set("one", {
    ...baseTeamState,
    queuedMessageNotifications: [queuedNotification],
  });
  expect(TestNotification.sent).toHaveLength(1);
  expect(TestNotification.sent[0]?.title).toBe('charlie queued a message in "Deploy pipeline"');
  expect(TestNotification.sent[0]?.options.body).toBe("Wait for smoke tests");
  expect(state.sound).toHaveBeenLastCalledWith("input", expect.any(Function), "chime");
  expect(state.badge).toHaveBeenLastCalledWith(1);

  // Subsequent turnAttributed for Charlie's queued run MUST NOT duplicate or prematurely close Bob's alert!
  const charlieQueuedTurn = {
    turnId: "run-charlie-queued-1",
    threadId,
    authorMemberId: charlieId,
    authorPseudo: charlie.pseudo,
    createdAt: "2026-09-13T07:01:00.000Z",
  };
  state.shells.set(
    "one",
    shell({
      title: "Deploy pipeline",
      latestTurn: { turnId: "run-charlie-queued-1", state: "running", completedAt: null },
    }),
  );
  state.teamStates.set("one", {
    ...baseTeamState,
    latestTurnByThreadId: new Map([[threadId, charlieQueuedTurn]]),
    turnAuthorByTurnId: new Map([[charlieQueuedTurn.turnId, charlieQueuedTurn]]),
    queuedMessageNotifications: [queuedNotification],
  });
  expect(TestNotification.sent).toHaveLength(1);
  expect(TestNotification.sent[0]?.close).not.toHaveBeenCalled();

  // Notification authored by Bob himself or excluding Bob is ignored.
  state.teamStates.set("one", {
    ...baseTeamState,
    queuedMessageNotifications: [
      queuedNotification,
      {
        threadId,
        queuedRunId: "run-bob-self" as never,
        senderMemberId: bobId,
        senderPseudo: "bob" as never,
        recipientMemberIds: [aliceId],
        messagePreview: "Self queued",
        createdAt: "2026-09-13T07:02:00.000Z",
      },
    ],
  });
  expect(TestNotification.sent).toHaveLength(1);

  // Suspending Bob immediately closes his open queued-message notification and clears the badge.
  state.teamStates.set("one", {
    ...baseTeamState,
    currentMember: { ...bob, status: "suspended" },
    queuedMessageNotifications: [queuedNotification],
  });
  expect(TestNotification.sent[0]?.close).toHaveBeenCalledTimes(1);
  expect(state.badge).toHaveBeenLastCalledWith(0);

  // Re-activating Bob, receiving a new queued notification, and then losing thread access also clears it.
  const secondNotification = {
    threadId,
    queuedRunId: "run-charlie-queued-2" as never,
    senderMemberId: charlieId,
    senderPseudo: "charlie" as never,
    recipientMemberIds: [aliceId, bobId],
    messagePreview: "Second update",
    createdAt: "2026-09-13T07:03:00.000Z",
  };
  state.teamStates.set("one", {
    ...baseTeamState,
    queuedMessageNotifications: [queuedNotification, secondNotification],
  });
  expect(TestNotification.sent).toHaveLength(2);
  expect(state.badge).toHaveBeenLastCalledWith(1);

  state.teamStates.set("one", {
    ...baseTeamState,
    threadAttributions: [],
    attributionByThreadId: new Map(),
    queuedMessageNotifications: [queuedNotification, secondNotification],
  });
  expect(TestNotification.sent[1]?.close).toHaveBeenCalledTimes(1);
  expect(state.badge).toHaveBeenLastCalledWith(0);
});

it("plays per-team sound presets for remote Team Server threads and local team-project threads, while respecting off", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  const teamId = TeamId.make("team-sound");
  const viewId = TeamViewId.make("view-sound");
  const aliceId = TeamMemberId.make("member-alice-sound");
  const localProjectId = ProjectId.make("proj-local-team");
  const remoteProjectId = ProjectId.make("proj-remote-team");
  const repoKey = "github.com/acme/sound-repo";
  const alice: TeamMember = {
    id: aliceId,
    teamId,
    pseudo: "alice" as TeamPseudo,
    role: "owner",
    status: "active",
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const remoteThreadId = ThreadId.make("thread");
  const attribution = {
    threadId: remoteThreadId,
    teamId,
    creatorMemberId: aliceId,
    creatorPseudo: alice.pseudo,
    viewId,
    locked: false,
    lockedByMemberId: null,
    createdAt: "2026-09-13T07:00:00.000Z",
  };
  const assignment = {
    projectId: remoteProjectId,
    teamId,
    defaultViewId: viewId,
    repoIdentityKey: repoKey,
    assignedByMemberId: aliceId,
    createdAt: "2026-09-13T07:00:00.000Z",
    updatedAt: "2026-09-13T07:00:00.000Z",
  };
  const teamState: TeamEnvironmentState = {
    ...EMPTY_TEAM_ENVIRONMENT_STATE,
    team: {
      id: teamId,
      name: "Sound Team",
      defaultViewId: viewId,
      createdAt: "2026-09-13T07:00:00.000Z",
      updatedAt: "2026-09-13T07:00:00.000Z",
    },
    currentMember: alice,
    members: [alice],
    threadAttributions: [attribution],
    memberById: new Map([[aliceId, alice]]),
    attributionByThreadId: new Map([[remoteThreadId, attribution]]),
    teamProjects: [assignment],
    projectAssignmentByProjectId: new Map([[remoteProjectId, assignment]]),
    projectAssignmentByRepoKey: new Map([[repoKey, assignment]]),
  };

  // Environment "one" is the remote Team Server; "two" is Alice's local environment.
  state.teamStates.set("one", teamState);
  state.teamStates.set("two", EMPTY_TEAM_ENVIRONMENT_STATE);
  state.shells.set("two", {
    status: "live",
    snapshot: Option.some({
      projects: [
        {
          id: localProjectId,
          repositoryIdentity: {
            canonicalKey: "local/sound-repo",
            origin: { canonicalKey: repoKey },
          },
        },
      ],
      threads: [
        {
          ...toV2ThreadShell(thread),
          projectId: localProjectId,
        },
      ],
    }),
  });
  app.start();

  // 1. Remote Team Server thread defaults to "chime".
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn-1", state: "completed", completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  expect(state.sound).toHaveBeenLastCalledWith("completion", expect.any(Function), "chime");

  // 2. Local thread on the team-assigned project resolves teamId via repo identity and plays custom "marimba".
  state.teamNotificationSounds = { [teamId]: "marimba" };
  state.shells.set("two", {
    status: "live",
    snapshot: Option.some({
      projects: [
        {
          id: localProjectId,
          repositoryIdentity: {
            canonicalKey: "local/sound-repo",
            origin: { canonicalKey: repoKey },
          },
        },
      ],
      threads: [
        {
          ...toV2ThreadShell({
            ...thread,
            latestTurn: {
              turnId: "turn-local-1",
              state: "completed",
              completedAt: "2026-09-13T07:02:00.000Z",
            },
          }),
          projectId: localProjectId,
        },
      ],
    }),
  });
  expect(state.sound).toHaveBeenLastCalledWith("completion", expect.any(Function), "marimba");

  // 3. Setting team sound to "off" suppresses sound while still showing the desktop notification
  // (including for queued-message notifications).
  state.teamNotificationSounds = { [teamId]: "off" };
  const callsBeforeOff = state.sound.mock.calls.length;
  const notificationsBeforeOff = TestNotification.sent.length;
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn-2", state: "running", completedAt: null },
    }),
  );
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn-2", state: "completed", completedAt: "2026-09-13T07:03:00.000Z" },
    }),
  );
  expect(state.sound).toHaveBeenCalledTimes(callsBeforeOff);
  expect(TestNotification.sent).toHaveLength(notificationsBeforeOff + 1);

  state.teamStates.set("one", {
    ...teamState,
    queuedMessageNotifications: [
      {
        threadId: remoteThreadId,
        queuedRunId: "run-queued-off-1" as never,
        senderMemberId: TeamMemberId.make("member-colleague-sound"),
        senderPseudo: "bob" as TeamPseudo,
        recipientMemberIds: [aliceId],
        messagePreview: "Quiet queued alert",
        createdAt: "2026-09-13T07:03:30.000Z",
      },
    ],
  });
  expect(state.sound).toHaveBeenCalledTimes(callsBeforeOff);
  expect(TestNotification.sent).toHaveLength(notificationsBeforeOff + 2);
  expect(TestNotification.sent.at(-1)?.options.silent).toBe(true);
});
