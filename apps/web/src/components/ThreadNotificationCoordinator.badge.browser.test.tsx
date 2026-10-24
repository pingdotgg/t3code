import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal, type Screen } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  toast: vi.fn(),
  closeToast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  environmentIds: ["one", "two"],
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => useAtomValue(paramsAtom)) as never,
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
// The real `useParams` subscribes to the router; a plain getter would let memoized children miss
// route changes.
const paramsAtom = Atom.make<{ environmentId?: string; threadId?: string }>({});
const setParams = (params: { environmentId?: string; threadId?: string }) =>
  registry.set(paramsAtom, params);
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

it("closes a thread's in-app toast once the route opens that thread", async () => {
  await using app = setup();
  state.inApp = true;
  setParams({ environmentId: "two", threadId: "other" });
  focused = true;
  state.toast.mockReturnValue("toast-1");
  await app.render();
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00Z" },
    }),
  );
  await app.render();
  expect(state.toast).toHaveBeenCalledTimes(1);

  setParams({ environmentId: "one", threadId: "thread" });
  await app.render();
  expect(state.closeToast).toHaveBeenCalledWith("toast-1");
});

it("closes outstanding in-app toasts when all notifications are disabled", async () => {
  await using app = setup();
  state.mode = "off";
  state.inApp = true;
  setParams({ environmentId: "two", threadId: "other" });
  focused = true;
  state.toast.mockReturnValue("toast-1");
  await app.render();
  state.shells.set(
    "one",
    shell({
      latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00Z" },
    }),
  );
  await app.render();
  expect(state.toast).toHaveBeenCalledTimes(1);

  state.inApp = false;
  await app.render();
  expect(state.closeToast).toHaveBeenCalledWith("toast-1");
});

it("closes only notices for the opened environment and thread, including repeated notices", async () => {
  await using app = setup();
  state.inApp = true;
  focused = true;
  setParams({ environmentId: "two", threadId: "other" });
  state.shells.set("one", shell({}, { id: "unrelated" }));
  state.toast
    .mockReturnValueOnce("one-completed")
    .mockReturnValueOnce("one-approval")
    .mockReturnValueOnce("one-unrelated")
    .mockReturnValueOnce("two-completed");
  await app.render();

  const completed = {
    latestTurn: { turnId: "turn", state: "completed", completedAt: "2026-09-13T07:01:00Z" },
  };
  state.shells.set("one", shell(completed, { id: "unrelated" }));
  await app.render();
  expect(state.toast).toHaveBeenCalledTimes(1);
  state.shells.set("one", shell({ ...completed, hasPendingApprovals: true }, { id: "unrelated" }));
  await app.render();
  expect(state.toast).toHaveBeenCalledTimes(2);
  state.shells.set(
    "one",
    shell({ ...completed, hasPendingApprovals: true }, { ...completed, id: "unrelated" }),
  );
  await app.render();
  expect(state.toast).toHaveBeenCalledTimes(3);
  state.shells.set("two", shell(completed));
  await app.render();
  expect(state.toast).toHaveBeenCalledTimes(4);
  expect(state.closeToast).not.toHaveBeenCalled();

  setParams({ environmentId: "one", threadId: "thread" });
  await app.render();
  expect(state.closeToast.mock.calls).toEqual([["one-completed"], ["one-approval"]]);

  setParams({ environmentId: "two", threadId: "thread" });
  await app.render();
  expect(state.closeToast.mock.calls).toEqual([
    ["one-completed"],
    ["one-approval"],
    ["two-completed"],
  ]);

  setParams({ environmentId: "one", threadId: "unrelated" });
  await app.render();
  expect(state.closeToast.mock.calls).toEqual([
    ["one-completed"],
    ["one-approval"],
    ["two-completed"],
    ["one-unrelated"],
  ]);
});
