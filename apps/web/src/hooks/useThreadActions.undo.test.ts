import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";
import { toastManager } from "../components/ui/toast";
import { useThreadUndoNotice } from "./showThreadUndoNotice";

const commands = vi.hoisted(() => ({
  pin: vi.fn(),
  unpin: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  delete: vi.fn(),
  settle: vi.fn(),
  unsettle: vi.fn(),
  snooze: vi.fn(),
  unsnooze: vi.fn(),
}));
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  state: { location: { href: "/" }, matches: [{ params: {} as Record<string, string> }] },
}));
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
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({
  useNewThreadHandler: () => async () => {
    router.state.location.href = "/draft/project";
  },
}));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
const threadShell = vi.hoisted(() => ({
  title: "Thread",
  pinOrderKey: "a0",
  pinnedAt: null as string | null,
  snoozedUntil: null as string | null,
  projectId: "project",
  environmentId: "undo-env",
  session: null,
}));
// Archived rows have no loaded shell, so deleting one takes the unresolved path.
const shellLoaded = vi.hoisted(() => ({ current: true }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentServerConfigLoaded: () => true,
  readThreadShell: () => (shellLoaded.current ? threadShell : null),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.pin:
        return commands.pin;
      case threadEnvironment.unpin:
        return commands.unpin;
      case threadEnvironment.archive:
        return commands.archive;
      case threadEnvironment.unarchive:
        return commands.unarchive;
      case threadEnvironment.delete:
        return commands.delete;
      case threadEnvironment.settle:
        return commands.settle;
      case threadEnvironment.unsettle:
        return commands.unsettle;
      case threadEnvironment.snooze:
        return commands.snooze;
      case threadEnvironment.unsnooze:
        return commands.unsnooze;
      default:
        return vi.fn();
    }
  },
}));

const target = {
  environmentId: EnvironmentId.make("undo-env"),
  threadId: ThreadId.make("thread"),
};
function currentUndo() {
  const notice = useThreadUndoNotice.getState().notice;
  expect(notice).not.toBeNull();
  return notice!.undo;
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const command of Object.values(commands)) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  router.navigate.mockClear();
  router.state.location.href = "/";
  router.state.matches[0]!.params = {};
  threadShell.pinnedAt = null;
  threadShell.snoozedUntil = null;
  shellLoaded.current = true;
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("concurrent thread action Undo", () => {
  it.each([
    ["settleThread", "settle", "unsettle", "Settled"],
    ["snoozeThread", "snooze", "unsnooze", "Snoozed"],
    ["unpinThread", "unpin", "pin", "Unpinned"],
    ["archiveThread", "archive", "unarchive", "Archived"],
  ] as const)(
    "%s retains one undo for concurrent successful requests",
    async (handler, action, inverse, notice) => {
      const actions = useThreadActions();
      const run = () =>
        handler === "snoozeThread"
          ? actions.snoozeThread(target, "2099-01-01T09:00:00.000Z")
          : actions[handler](target);
      await Promise.all([run(), run()]);
      expect(commands[action]).toHaveBeenCalledTimes(2);
      expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: notice, count: 1 });
      await currentUndo()();
      expect(commands[inverse]).toHaveBeenCalledOnce();
    },
  );
});

describe("unpin Undo", () => {
  it("restores the original snooze after restoring the pin", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2030-01-01T09:00:00.000Z";
    await useThreadActions().unpinThread(target);
    await currentUndo()();
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil: threadShell.snoozedUntil },
    });
    expect(commands.pin.mock.invocationCallOrder[0]).toBeLessThan(
      commands.snooze.mock.invocationCallOrder[0]!,
    );
  });

  it("restores the pin without an already expired snooze", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2000-01-01T09:00:00.000Z";
    await useThreadActions().unpinThread(target);
    await currentUndo()();
    expect(commands.pin).toHaveBeenCalledOnce();
    expect(commands.snooze).not.toHaveBeenCalled();
  });

  it("ignores an old notice across hook instances and still restores the latest unpin", async () => {
    const sidebar = useThreadActions();
    const header = useThreadActions();
    await sidebar.unpinThread(target);
    const staleUndo = currentUndo();
    await header.pinThread(target, { orderKey: "a1" });
    await header.unpinThread(target);
    const latestUndo = currentUndo();
    await staleUndo();
    expect(commands.pin).toHaveBeenCalledTimes(1);
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
    expect(commands.pin).toHaveBeenLastCalledWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    await latestUndo();
    expect(commands.pin).toHaveBeenCalledTimes(2);
  });
});

describe("archive Undo", () => {
  it("unarchives and returns to the thread when archiving left it", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    const actions = useThreadActions();
    await actions.archiveThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived", count: 1 });
    expect(add).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId },
    });
    expect(router.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "/$environmentId/$threadId",
        params: { environmentId: target.environmentId, threadId: target.threadId },
      }),
    );
  });
});

describe("archive navigation", () => {
  it.each([
    { destination: "/undo-env/thread", expected: "/draft/project" },
    { destination: "/undo-env/other-thread", expected: "/undo-env/other-thread" },
    { destination: "/settings", expected: "/settings" },
  ])("ends at $expected after opening $destination while archiving", async (route) => {
    router.state.location.href = "/undo-env/thread";
    router.state.matches[0]!.params = {
      environmentId: target.environmentId,
      threadId: target.threadId,
    };
    let finishArchive!: () => void;
    commands.archive.mockReturnValue(
      new Promise((resolve) => {
        finishArchive = () => resolve({ _tag: "Success", value: undefined });
      }),
    );
    const archived = useThreadActions().archiveThread(target);
    router.state.location.href = route.destination;
    finishArchive();
    expect((await archived)._tag).toBe("Success");
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Archived" });
    expect(router.state.location.href).toBe(route.expected);
  });
});

describe("settle and snooze Undo", () => {
  it("un-settles from the notice and expires the Undo after a manual un-settle", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.settleThread(target);
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled", count: 1 });
    expect(add).not.toHaveBeenCalled();
    const undo = currentUndo();
    await actions.unsettleThread(target);
    await undo();
    expect(commands.unsettle).toHaveBeenCalledOnce();
  });

  it("re-pins and re-snoozes a thread that settling had cleared", async () => {
    const snoozedUntil = "2030-01-01T09:00:00.000Z";
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = snoozedUntil;
    const actions = useThreadActions();
    await actions.settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, orderKey: "a0" },
    });
    expect(commands.snooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, snoozedUntil },
    });
  });

  it("stops settle restoration if restoring the pin fails", async () => {
    threadShell.pinnedAt = "2026-01-01T00:00:00.000Z";
    threadShell.snoozedUntil = "2030-01-01T09:00:00.000Z";
    commands.pin.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("Pin failed")) });
    vi.spyOn(toastManager, "add").mockReturnValue("toast");
    await useThreadActions().settleThread(target);
    await currentUndo()();
    expect(commands.unsettle).toHaveBeenCalledOnce();
    expect(commands.pin).toHaveBeenCalledOnce();
    expect(commands.snooze).not.toHaveBeenCalled();
  });

  it("expires an older unpin Undo when the thread is settled", async () => {
    const actions = useThreadActions();
    await actions.unpinThread(target);
    const staleUnpinUndo = currentUndo();
    await actions.settleThread(target);
    await staleUnpinUndo();
    expect(commands.pin).not.toHaveBeenCalled();
  });

  // regression: #12972 the sidebar undo notice must reverse a snooze
  it("wakes the thread from the snooze notice", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const actions = useThreadActions();
    await actions.snoozeThread(target, "2100-01-01T00:00:00.000Z");
    expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Snoozed", count: 1 });
    expect(add).not.toHaveBeenCalled();
    await currentUndo()();
    expect(commands.unsnooze).toHaveBeenCalledExactlyOnceWith({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, reason: "user" },
    });
  });
});

describe("archive and delete Undo expiry", () => {
  const otherThread = { environmentId: target.environmentId, threadId: ThreadId.make("other") };
  const otherEnvironment = {
    environmentId: EnvironmentId.make("other-env"),
    threadId: target.threadId,
  };
  const failure = { _tag: "Failure", cause: Cause.fail(new Error("Request failed")) };

  describe.each(["archiveThread", "deleteThread"] as const)("%s", (lifecycle) => {
    it.each([
      ["settleThread", "unsettle"],
      ["snoozeThread", "unsnooze"],
      ["unpinThread", "pin"],
    ] as const)(
      "expires an earlier %s Undo for that thread only, across hook instances",
      async (handler, inverse) => {
        const sidebar = useThreadActions();
        const header = useThreadActions();
        for (const ref of [otherThread, otherEnvironment, target]) {
          await (handler === "snoozeThread"
            ? sidebar.snoozeThread(ref, "2099-01-01T09:00:00.000Z")
            : sidebar[handler](ref));
        }
        const staleUndo = currentUndo();
        await header[lifecycle](target);
        await staleUndo();
        expect(commands[inverse]).toHaveBeenCalledTimes(2);
        expect(commands[inverse]).not.toHaveBeenCalledWith(
          expect.objectContaining({
            environmentId: target.environmentId,
            input: expect.objectContaining({ threadId: target.threadId }),
          }),
        );
      },
    );

    it("keeps the earlier Undo when the request fails", async () => {
      const actions = useThreadActions();
      await actions.settleThread(target);
      commands[lifecycle === "archiveThread" ? "archive" : "delete"].mockResolvedValue(failure);
      await actions[lifecycle](target);
      expect(useThreadUndoNotice.getState().notice).toMatchObject({ action: "Settled" });
      await currentUndo()();
      expect(commands.unsettle).toHaveBeenCalledOnce();
    });
  });

  it.each([true, false])(
    "expires the Archived Undo when deleting with shell loaded: %s",
    async (loaded) => {
      const actions = useThreadActions();
      await actions.archiveThread(target);
      const staleUndo = currentUndo();
      shellLoaded.current = loaded;
      await actions.deleteThread(target);
      expect(useThreadUndoNotice.getState().notice).toBeNull();
      await staleUndo();
      expect(commands.unarchive).not.toHaveBeenCalled();
    },
  );
});
