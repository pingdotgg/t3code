import { RegistryContext } from "@effect/atom-react";
import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render, stubGlobal, type Screen } from "../../test/render";

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
  latestRunSilent: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
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
    latestRunSilent: input.latestRunSilent,
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
// The mocked modules read `state`, the registry and the focus flags, so every test starts by
// resetting them. The first render is left to the test because some tests change state first.
function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.environmentIds = ["one", "two"];
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
  const ui = () => (
    <RegistryContext.Provider value={testRegistry}>
      <ThreadNotificationCoordinator />
    </RegistryContext.Provider>
  );
  let screen: Screen | undefined;
  return {
    ui,
    async render() {
      if (screen) await screen.rerender(ui());
      else screen = stack.use(await render(ui()));
    },
    unmount: () => screen!.unmount(),
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
  "badges %s and clears when notifications are disabled",
  async (flag) => {
    await using app = setup();
    await app.render();
    state.shells.set("one", shell({ [flag]: true }));
    await app.render();
    expect(state.badge).toHaveBeenLastCalledWith(1);
    const notification = TestNotification.sent[0]!;
    notification.dispatchEvent(new Event("click"));
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: EnvironmentId.make("one"), threadId: "thread" },
    });
    state.mode = "sound";
    await app.render();
    expect(state.badge).toHaveBeenLastCalledWith(0);
    expect(notification.close).toHaveBeenCalled();
  },
);

it.each([
  ["pre-expiry compaction", true, "completed", []],
  ["manual compaction", false, "completed", ["Thread completed"]],
  ["failed pre-expiry compaction", true, "error", ["Thread failed"]],
] as const)("notifies for %s only when attention is needed", async (_, silent, status, titles) => {
  await using app = setup();
  state.environmentIds = ["one"];
  state.shells.set("one", shell({ latestRunSilent: silent }));
  await using screen = await render(app.ui());
  state.shells.set(
    "one",
    shell({
      latestRunSilent: silent,
      latestTurn: { turnId: "turn", state: status, completedAt: "2026-09-13T07:01:00.000Z" },
    }),
  );
  using _timers = fakeTimers();
  await screen.rerender(app.ui());
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  expect(TestNotification.sent.map((notification) => notification.title)).toEqual(titles);
});

it("holds a completion through a continuation gap and notifies once it settles", async () => {
  await using app = setup();
  await app.render();
  using _timers = fakeTimers();
  const finished = (turnId: string, completedAt: string) => ({
    latestTurn: { turnId, state: "completed", completedAt },
  });
  state.shells.set("one", shell(finished("turn-1", "2026-09-13T07:00:01.000Z")));
  await app.render();
  state.shells.set(
    "one",
    shell({ latestTurn: { turnId: "turn-2", state: "running", completedAt: null } }),
  );
  await app.render();
  state.shells.set("one", shell(finished("turn-2", "2026-09-13T07:00:02.000Z")));
  await app.render();
  expect(TestNotification.sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS - 1);
  expect(TestNotification.sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(TestNotification.sent.map((sent) => sent.title)).toEqual(["Thread completed"]);
});
