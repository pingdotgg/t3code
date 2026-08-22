import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  function createCommandMocks<const Names extends readonly string[]>(...names: Names) {
    type Name = Names[number];

    const commands = {} as Record<Name, object>;
    const mutations = {} as Record<Name, ReturnType<typeof vi.fn>>;
    const mutationsByCommand = new Map<object, ReturnType<typeof vi.fn>>();

    for (const name of names as readonly Name[]) {
      const command = {};
      const mutation = vi.fn();
      commands[name] = command;
      mutations[name] = mutation;
      mutationsByCommand.set(command, mutation);
    }

    return {
      commands,
      mutations,
      resolve(command: object) {
        const mutation = mutationsByCommand.get(command);
        if (!mutation) throw new Error("Unexpected thread command");
        return mutation;
      },
    };
  }

  const threadCommands = createCommandMocks(
    "archive",
    "delete",
    "pin",
    "reorderPin",
    "settle",
    "snooze",
    "unarchive",
    "unsnooze",
    "unpin",
    "unsettle",
    "updateMetadata",
  );
  const threadShellsAtom = {};

  return {
    alert: vi.fn(),
    canSettle: vi.fn(),
    canSnooze: vi.fn(),
    impactAsync: vi.fn(),
    refreshArchivedThreadsForEnvironment: vi.fn(),
    serverConfigs: new Map<string, unknown>(),
    threadShells: [] as EnvironmentThreadShell[],
    threadShellsAtom,
    threadCommands,
  };
});

vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useRef: <A>(initialValue: A) => ({ current: initialValue }),
}));

vi.mock("react-native", () => ({
  Alert: { alert: mocks.alert },
}));

vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: mocks.impactAsync,
}));

vi.mock("@t3tools/client-runtime/state/thread-settled", () => ({
  canSettle: mocks.canSettle,
  canSnooze: mocks.canSnooze,
}));

vi.mock("../../components/ConfirmDialogHost", () => ({
  showConfirmDialog: vi.fn(),
}));

vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: mocks.refreshArchivedThreadsForEnvironment,
}));

vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: object) =>
      atom === mocks.threadShellsAtom ? mocks.threadShells : mocks.serverConfigs,
  },
}));

vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: {},
}));

vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellsAtom: mocks.threadShellsAtom },
  threadEnvironment: mocks.threadCommands.commands,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: object) => mocks.threadCommands.resolve(command),
}));

import { useArchivedThreadListActions, useThreadListActions } from "./useThreadListActions";

const success = { _tag: "Success", value: undefined } as const;

function failure(message: string) {
  return { _tag: "Failure", cause: Cause.fail(new Error(message)) } as const;
}

function makeThread(id = "thread-1", environmentId = "environment-1"): EnvironmentThreadShell {
  return {
    environmentId,
    id,
    title: "Archive settings",
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  } as unknown as EnvironmentThreadShell;
}

describe("useThreadListActions merged archive and settlement contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mutation of Object.values(mocks.threadCommands.mutations)) {
      mutation.mockResolvedValue(success);
    }
    mocks.canSettle.mockReturnValue(true);
    mocks.canSnooze.mockReturnValue(true);
    mocks.impactAsync.mockResolvedValue(undefined);
    mocks.serverConfigs.clear();
    mocks.threadShells.length = 0;
    mocks.serverConfigs.set("environment-1", {
      environment: { capabilities: { threadSettlement: true, threadSnooze: true } },
    });
  });

  it("returns tri-state archive results and suppresses per-row bulk feedback", async () => {
    const thread = makeThread();
    const actions = useArchivedThreadListActions();

    await expect(actions.unarchiveThread(thread)).resolves.toBe("succeeded");
    expect(mocks.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith("environment-1");

    mocks.threadCommands.mutations.delete.mockResolvedValueOnce(failure("delete denied"));
    await expect(actions.deleteThread(thread, { reportFailure: false })).resolves.toBe("failed");
    expect(mocks.alert).not.toHaveBeenCalled();

    mocks.refreshArchivedThreadsForEnvironment.mockClear();
    await expect(
      actions.unarchiveThread(thread, {
        reportFailure: false,
        refreshArchivedThreads: false,
      }),
    ).resolves.toBe("succeeded");
    expect(mocks.refreshArchivedThreadsForEnvironment).not.toHaveBeenCalled();
  });

  it("reports a duplicate archived-thread action as skipped while the first action settles", async () => {
    const thread = makeThread();
    let completeFirst!: (result: typeof success) => void;
    mocks.threadCommands.mutations.unarchive.mockReturnValueOnce(
      new Promise<typeof success>((resolve) => {
        completeFirst = resolve;
      }),
    );
    const actions = useArchivedThreadListActions();

    const first = actions.unarchiveThread(thread, { reportFailure: false });
    await expect(actions.unarchiveThread(thread, { reportFailure: false })).resolves.toBe(
      "skipped",
    );
    expect(mocks.threadCommands.mutations.unarchive).toHaveBeenCalledOnce();
    expect(mocks.impactAsync).toHaveBeenCalledOnce();

    completeFirst(success);
    await expect(first).resolves.toBe("succeeded");
  });

  it("does not deduplicate distinct scoped threads whose ids contain separators", async () => {
    const firstThread = makeThread("thread", "environment:one");
    const secondThread = makeThread("one:thread", "environment");
    let completeFirst!: (result: typeof success) => void;
    mocks.threadCommands.mutations.unarchive.mockReturnValueOnce(
      new Promise<typeof success>((resolve) => {
        completeFirst = resolve;
      }),
    );
    const actions = useArchivedThreadListActions();

    const first = actions.unarchiveThread(firstThread, { reportFailure: false });
    await expect(actions.unarchiveThread(secondThread, { reportFailure: false })).resolves.toBe(
      "succeeded",
    );
    expect(mocks.threadCommands.mutations.unarchive).toHaveBeenCalledTimes(2);

    completeFirst(success);
    await expect(first).resolves.toBe("succeeded");
  });

  it("keeps the void archive adapter deduplicated and refreshes after success", async () => {
    const thread = makeThread();
    let completeArchive!: (result: typeof success) => void;
    mocks.threadCommands.mutations.archive.mockReturnValueOnce(
      new Promise<typeof success>((resolve) => {
        completeArchive = resolve;
      }),
    );
    const actions = useThreadListActions();

    actions.archiveThread(thread);
    actions.archiveThread(thread);
    expect(mocks.threadCommands.mutations.archive).toHaveBeenCalledOnce();

    completeArchive(success);
    await vi.waitFor(() => {
      expect(mocks.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith("environment-1");
    });
  });

  it("adapts settlement success and failure to booleans for Thread List v2", async () => {
    const thread = makeThread();
    mocks.threadCommands.mutations.unsettle.mockResolvedValueOnce(failure("unsettle denied"));
    const actions = useThreadListActions();

    await expect(actions.settleThread(thread)).resolves.toBe(true);
    await expect(actions.unsettleThread(thread)).resolves.toBe(false);

    expect(mocks.threadCommands.mutations.settle).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { threadId: "thread-1" },
    });
    expect(mocks.threadCommands.mutations.unsettle).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { threadId: "thread-1", reason: "user" },
    });
    expect(mocks.alert).toHaveBeenCalledWith("Could not un-settle thread", "unsettle denied");
  });

  it("keeps snooze reservations collision-safe for scoped thread ids", async () => {
    const firstThread = makeThread("thread", "environment:one");
    const secondThread = makeThread("one:thread", "environment");
    const snoozedUntil = "2099-01-01T00:00:00.000Z";
    let completeFirst!: (result: typeof success) => void;
    mocks.serverConfigs.set("environment:one", {
      environment: { capabilities: { threadSettlement: true, threadSnooze: true } },
    });
    mocks.serverConfigs.set("environment", {
      environment: { capabilities: { threadSettlement: true, threadSnooze: true } },
    });
    mocks.threadCommands.mutations.snooze.mockReturnValueOnce(
      new Promise<typeof success>((resolve) => {
        completeFirst = resolve;
      }),
    );
    const actions = useThreadListActions();

    const first = actions.snoozeThread(firstThread, snoozedUntil);
    await expect(actions.snoozeThread(firstThread, snoozedUntil)).resolves.toBe(false);
    await expect(actions.snoozeThread(secondThread, snoozedUntil)).resolves.toBe(true);
    expect(mocks.threadCommands.mutations.snooze).toHaveBeenCalledTimes(2);

    completeFirst(success);
    await expect(first).resolves.toBe(true);
  });

  it("keeps title-regeneration reservations collision-safe for scoped thread ids", async () => {
    const firstThread = makeThread("thread", "environment:one");
    const secondThread = makeThread("one:thread", "environment");
    let completeFirst!: (result: typeof success) => void;
    mocks.serverConfigs.set("environment:one", {
      environment: { capabilities: { threadTitleRegeneration: true } },
    });
    mocks.serverConfigs.set("environment", {
      environment: { capabilities: { threadTitleRegeneration: true } },
    });
    mocks.threadCommands.mutations.updateMetadata.mockReturnValueOnce(
      new Promise<typeof success>((resolve) => {
        completeFirst = resolve;
      }),
    );
    const actions = useThreadListActions();

    const first = actions.regenerateThreadTitle(firstThread);
    await expect(actions.regenerateThreadTitle(secondThread)).resolves.toBe(true);
    expect(mocks.threadCommands.mutations.updateMetadata).toHaveBeenCalledTimes(2);

    completeFirst(success);
    await expect(first).resolves.toBe(true);
  });

  it("keeps pinned reorder identities collision-safe across environments", async () => {
    const firstThread = {
      ...makeThread("thread", "environment:a"),
      archivedAt: null,
      createdAt: "2026-08-07T10:00:00.000Z",
      pinnedAt: "2026-08-07T10:00:00.000Z",
      pinOrderKey: "f",
    };
    const secondThread = {
      ...makeThread("a:thread", "environment"),
      archivedAt: null,
      createdAt: "2026-08-07T11:00:00.000Z",
      pinnedAt: "2026-08-07T11:00:00.000Z",
      pinOrderKey: "m",
    };
    mocks.serverConfigs.set("environment:a", {
      environment: { capabilities: { threadPinReorder: true } },
    });
    mocks.serverConfigs.set("environment", {
      environment: { capabilities: { threadPinReorder: true } },
    });
    mocks.threadShells.push(firstThread, secondThread);
    const actions = useThreadListActions();

    await expect(actions.movePinnedThread(secondThread, "up")).resolves.toBe(true);
    expect(mocks.threadCommands.mutations.reorderPin).toHaveBeenCalledOnce();
    expect(mocks.threadCommands.mutations.reorderPin).toHaveBeenCalledWith({
      environmentId: "environment",
      input: {
        threadId: "a:thread",
        orderKey: expect.any(String),
      },
    });
  });
});
