import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { navigateAfterThreadDeletion, useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import { useThreadUndoNotice } from "./showThreadUndoNotice";

const commands = vi.hoisted(() => ({
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
  attachToGroup: vi.fn(),
  detachFromGroup: vi.fn(),
}));
const confirm = vi.hoisted(() => vi.fn());
type TestShell = {
  id: string;
  environmentId: string;
  title: string;
  createdAt: string;
  groupParentThreadId: string | null;
  groupOrderKey: string | null;
  runtime: { status: string } | null;
  settledOverride: "settled" | "active" | null;
  snoozedUntil: string | null;
  pinnedAt: string | null;
  activeOrderKey: string | null;
  unsettledAt: string | null;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
};
const shells = vi.hoisted(() => ({ list: [] as TestShell[] }));

vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { location: { href: "/" }, matches: [] }, navigate: vi.fn() }),
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => async () => {} }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm } }) }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentServerConfigLoaded: () => true,
  readThreadShells: () => shells.list,
  readThreadShell: (ref: { threadId: string }) =>
    shells.list.find((shell) => shell.id === ref.threadId) ?? null,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
      case threadEnvironment.attachToGroup:
        return commands.attachToGroup;
      case threadEnvironment.detachFromGroup:
        return commands.detachFromGroup;
      default:
        return vi.fn();
    }
  },
}));

const environmentId = EnvironmentId.make("group-env");
const ref = (id: string) => ({ environmentId, threadId: ThreadId.make(id) });
const shell = (id: string, overrides: Partial<TestShell> = {}): TestShell => ({
  id,
  environmentId,
  title: id,
  createdAt: "2026-01-01T00:00:00.000Z",
  groupParentThreadId: null,
  groupOrderKey: null,
  runtime: null,
  settledOverride: null,
  snoozedUntil: null,
  pinnedAt: null,
  activeOrderKey: null,
  unsettledAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...overrides,
});
const settledIds = () =>
  commands.settle.mock.calls.map(([call]) => call.input.threadId as string).toSorted();

beforeEach(() => {
  vi.useFakeTimers();
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  confirm.mockReset().mockResolvedValue(true);
  shells.list = [
    shell("parent"),
    shell("done", { groupParentThreadId: "parent" }),
    shell("busy", { groupParentThreadId: "parent", runtime: { status: "running" } }),
    shell("old", { groupParentThreadId: "parent", settledOverride: "settled" }),
  ];
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("navigateAfterThreadDeletion", () => {
  it("reports a rejected navigation without failing the completed deletion", async () => {
    const addToast = vi.spyOn(toastManager, "add").mockReturnValue("navigation-error");

    await expect(
      navigateAfterThreadDeletion(() => Promise.reject(new Error("route unavailable"))),
    ).resolves.toBeUndefined();

    expect(addToast).toHaveBeenCalledOnce();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Thread deleted, but navigation failed",
        description: "route unavailable",
      }),
    );
  });
});

describe("thread groups", () => {
  it("settleThreadGroup settles parent and workers, finishedOnly skips working", async () => {
    await useThreadActions().settleThreadGroup(ref("parent"), { finishedOnly: true });
    expect(settledIds()).toEqual(["done", "parent"]);
    expect(confirm).not.toHaveBeenCalled();

    commands.settle.mockClear();
    await useThreadActions().settleThreadGroup(ref("parent"), { finishedOnly: false });
    expect(settledIds()).toEqual(["busy", "done", "parent"]);
  });

  it("finishedOnly leaves a running lead alone and settles only finished workers", async () => {
    shells.list[0] = shell("parent", { runtime: { status: "running" } });
    await useThreadActions().settleThreadGroup(ref("parent"), { finishedOnly: true });
    expect(settledIds()).toEqual(["done"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("settleThreadGroup asks before settling working members", async () => {
    confirm.mockResolvedValue(false);
    await useThreadActions().settleThreadGroup(ref("parent"), { finishedOnly: false });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      "1 thread in this group is still working.\nSettle the whole group anyway?",
    );
    expect(commands.settle).not.toHaveBeenCalled();
    expect(useThreadUndoNotice.getState().notice).toBeNull();
  });

  it("group settle undo restores every thread", async () => {
    await useThreadActions().settleThreadGroup(ref("parent"), { finishedOnly: true });
    const notice = useThreadUndoNotice.getState().notice;
    expect(notice).toMatchObject({ action: "Settled", count: 2 });
    await notice!.undo();
    expect(
      commands.unsettle.mock.calls.map(([call]) => call.input.threadId as string).toSorted(),
    ).toEqual(["done", "parent"]);
  });

  it("snoozeThreadGroup snoozes parent and workers that are neither snoozed nor settled", async () => {
    shells.list.push(
      shell("sleeping", {
        groupParentThreadId: "parent",
        snoozedUntil: "2999-01-01T00:00:00.000Z",
      }),
    );
    await useThreadActions().snoozeThreadGroup(ref("parent"), "2099-01-01T09:00:00.000Z");
    expect(
      commands.snooze.mock.calls.map(([call]) => call.input.threadId as string).toSorted(),
    ).toEqual(["busy", "done", "parent"]);
    await useThreadUndoNotice.getState().notice!.undo();
    expect(commands.unsnooze).toHaveBeenCalledTimes(3);
  });

  it("snoozeThreadGroup keeps members that cannot snooze live and still snoozes the rest", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("skipped-toast");
    shells.list.push(shell("asking", { groupParentThreadId: "parent", hasPendingApprovals: true }));
    const result = await useThreadActions().snoozeThreadGroup(
      ref("parent"),
      "2099-01-01T09:00:00.000Z",
    );
    expect(result._tag).toBe("Success");
    expect(
      commands.snooze.mock.calls.map(([call]) => call.input.threadId as string).toSorted(),
    ).toEqual(["busy", "done", "parent"]);
    expect(add).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "warning", title: "1 thread could not be snoozed" }),
    );
  });

  it("attaches and detaches through the group commands", async () => {
    const actions = useThreadActions();
    await actions.attachThreadToGroup(ref("done"), ref("other"));
    expect(commands.attachToGroup).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: "done", parentThreadId: "other" },
    });
    await actions.detachThreadFromGroup(ref("done"));
    expect(commands.detachFromGroup).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: "done" },
    });
  });
});
