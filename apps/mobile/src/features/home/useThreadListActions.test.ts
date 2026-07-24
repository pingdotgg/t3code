import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const commands = {
    archive: {},
    delete: {},
    settle: {},
    unarchive: {},
    unsettle: {},
  };

  return {
    alert: vi.fn(),
    archiveMutation: vi.fn(),
    canSettle: vi.fn(),
    commands,
    deleteMutation: vi.fn(),
    impactAsync: vi.fn(),
    refreshArchivedThreadsForEnvironment: vi.fn(),
    serverConfigs: new Map<string, unknown>(),
    settleMutation: vi.fn(),
    unarchiveMutation: vi.fn(),
    unsettleMutation: vi.fn(),
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
}));

vi.mock("../../components/ConfirmDialogHost", () => ({
  showConfirmDialog: vi.fn(),
}));

vi.mock("../archive/useArchivedThreadSnapshots", () => ({
  refreshArchivedThreadsForEnvironment: mocks.refreshArchivedThreadsForEnvironment,
}));

vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: {
    get: () => mocks.serverConfigs,
  },
}));

vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: {},
}));

vi.mock("../../state/threads", () => ({
  threadEnvironment: mocks.commands,
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: object) => {
    if (command === mocks.commands.archive) return mocks.archiveMutation;
    if (command === mocks.commands.unarchive) return mocks.unarchiveMutation;
    if (command === mocks.commands.delete) return mocks.deleteMutation;
    if (command === mocks.commands.settle) return mocks.settleMutation;
    if (command === mocks.commands.unsettle) return mocks.unsettleMutation;
    throw new Error("Unexpected thread command");
  },
}));

import { useArchivedThreadListActions, useThreadListActions } from "./useThreadListActions";

const success = { _tag: "Success", value: undefined } as const;

function failure(message: string) {
  return { _tag: "Failure", cause: Cause.fail(new Error(message)) } as const;
}

function makeThread(id = "thread-1"): EnvironmentThreadShell {
  return {
    environmentId: "environment-1",
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
    mocks.archiveMutation.mockResolvedValue(success);
    mocks.unarchiveMutation.mockResolvedValue(success);
    mocks.deleteMutation.mockResolvedValue(success);
    mocks.settleMutation.mockResolvedValue(success);
    mocks.unsettleMutation.mockResolvedValue(success);
    mocks.canSettle.mockReturnValue(true);
    mocks.impactAsync.mockResolvedValue(undefined);
    mocks.serverConfigs.clear();
    mocks.serverConfigs.set("environment-1", {
      environment: { capabilities: { threadSettlement: true } },
    });
  });

  it("returns tri-state archive results and suppresses per-row bulk feedback", async () => {
    const thread = makeThread();
    const actions = useArchivedThreadListActions();

    await expect(actions.unarchiveThread(thread)).resolves.toBe("succeeded");
    expect(mocks.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith("environment-1");

    mocks.deleteMutation.mockResolvedValueOnce(failure("delete denied"));
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
    mocks.unarchiveMutation.mockReturnValueOnce(
      new Promise<typeof success>((resolve) => {
        completeFirst = resolve;
      }),
    );
    const actions = useArchivedThreadListActions();

    const first = actions.unarchiveThread(thread, { reportFailure: false });
    await expect(actions.unarchiveThread(thread, { reportFailure: false })).resolves.toBe(
      "skipped",
    );
    expect(mocks.unarchiveMutation).toHaveBeenCalledOnce();
    expect(mocks.impactAsync).toHaveBeenCalledOnce();

    completeFirst(success);
    await expect(first).resolves.toBe("succeeded");
  });

  it("keeps the void archive adapter deduplicated and refreshes after success", async () => {
    const thread = makeThread();
    let completeArchive!: (result: typeof success) => void;
    mocks.archiveMutation.mockReturnValueOnce(
      new Promise<typeof success>((resolve) => {
        completeArchive = resolve;
      }),
    );
    const actions = useThreadListActions();

    actions.archiveThread(thread);
    actions.archiveThread(thread);
    expect(mocks.archiveMutation).toHaveBeenCalledOnce();

    completeArchive(success);
    await vi.waitFor(() => {
      expect(mocks.refreshArchivedThreadsForEnvironment).toHaveBeenCalledWith("environment-1");
    });
  });

  it("adapts settlement success and failure to booleans for Thread List v2", async () => {
    const thread = makeThread();
    mocks.unsettleMutation.mockResolvedValueOnce(failure("unsettle denied"));
    const actions = useThreadListActions();

    await expect(actions.settleThread(thread)).resolves.toBe(true);
    await expect(actions.unsettleThread(thread)).resolves.toBe(false);

    expect(mocks.settleMutation).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { threadId: "thread-1" },
    });
    expect(mocks.unsettleMutation).toHaveBeenCalledWith({
      environmentId: "environment-1",
      input: { threadId: "thread-1", reason: "user" },
    });
    expect(mocks.alert).toHaveBeenCalledWith("Could not un-settle thread", "unsettle denied");
  });
});
