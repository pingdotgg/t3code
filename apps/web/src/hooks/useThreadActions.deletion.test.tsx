import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { deleteSelectedThreadEntries } from "../components/Sidebar.logic";
import { useThreadActions } from "./useThreadActions";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../state/server";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  run: vi.fn(),
  readThreadShell: vi.fn(),
  readProject: vi.fn(),
  readEnvironmentThreadRefs: vi.fn(),
  confirmThreadDelete: false,
  recoverableDeletion: true,
  automaticCleanup: false,
  archived: vi.fn(),
  toastAdd: vi.fn(
    (_toast: {
      title: string;
      description: string;
      actionProps?: { onClick: () => Promise<void> };
    }) => "cleanup-toast",
  ),
  toastClose: vi.fn(),
  toastUpdate: vi.fn(),
}));
vi.mock("../state/server", async (importOriginal) => {
  const { Atom } = await import("effect/unstable/reactivity");
  const { DEFAULT_SERVER_SETTINGS, EnvironmentId } = await import("@t3tools/contracts");
  return {
    ...(await importOriginal<typeof import("../state/server")>()),
    environmentServerConfigsAtom: Atom.make(
      () =>
        new Map([
          [
            EnvironmentId.make("local"),
            {
              settings: {
                ...DEFAULT_SERVER_SETTINGS,
                storageCleanup: {
                  ...DEFAULT_SERVER_SETTINGS.storageCleanup,
                  worktreeOnDelete: mocks.automaticCleanup,
                },
              },
            },
          ],
        ]),
    ),
  };
});
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  executeAtomQuery: mocks.archived,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => (input: unknown) =>
    mocks.run(command.label, input),
}));
vi.mock("../state/entities", () => ({
  readThreadShell: mocks.readThreadShell,
  readEnvironmentThreadRefs: mocks.readEnvironmentThreadRefs,
  readProject: mocks.readProject,
  readEnvironmentSupportsRecoverableDeletion: () => mocks.recoverableDeletion,
}));
vi.mock("./useSettings", () => ({
  useClientSettings: (select: (settings: object) => unknown) =>
    select({ confirmThreadDelete: mocks.confirmThreadDelete, sidebarThreadSortOrder: "updatedAt" }),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { matches: [] } }),
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm: mocks.confirm } }) }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (value: unknown) => value,
  toastManager: { add: mocks.toastAdd, close: mocks.toastClose, update: mocks.toastUpdate },
}));

const environmentId = EnvironmentId.make("local");
const threads = ["one", "two", "three"].map((id) => ({
  id: ThreadId.make(id),
  environmentId,
  projectId: ProjectId.make(`project-${id}`),
  title: id,
  session: null,
  worktreePath: `/repo/${id}`,
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
}));
const entries = threads.map((thread) => {
  const threadRef = scopeThreadRef(environmentId, thread.id);
  return { threadRef, threadKey: scopedThreadKey(threadRef) };
});
let actions: ReturnType<typeof useThreadActions>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useThreadActions();
  useLayoutEffect(() => {
    actions = value;
  });
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.confirmThreadDelete = false;
  mocks.recoverableDeletion = true;
  mocks.automaticCleanup = false;
  appAtomRegistry.refresh(environmentServerConfigsAtom);
  mocks.readProject.mockReturnValue({ workspaceRoot: "/repo" });
  mocks.confirm.mockResolvedValue(true);
  mocks.run.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  mocks.archived.mockResolvedValue(AsyncResult.success({ threads: [] }));
  // Keep the snapshot stale to exercise successful-deletion tracking.
  mocks.readThreadShell.mockImplementation(
    ({ threadId }) => threads.find((thread) => thread.id === threadId) ?? null,
  );
  mocks.readEnvironmentThreadRefs.mockReturnValue(entries.map((entry) => entry.threadRef));
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("keeps conversations until worktree cleanup succeeds without blocking the rest of the batch", async () => {
  mocks.readProject.mockImplementation(({ projectId }) => ({ workspaceRoot: `/${projectId}` }));
  let startCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    startCleanup = resolve;
  });
  let finishCleanup!: () => void;
  const releaseCleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const deleted: string[] = [];
  const removals: string[] = [];
  mocks.run.mockImplementation(async (label, { input }) => {
    if (label.endsWith(":thread:delete") && input.deleteWorktreePath) {
      removals.push(input.deleteWorktreePath);
      if (removals.length === 3) startCleanup();
      await releaseCleanup;
    }
    if (label.endsWith(":thread:delete")) deleted.push(input.threadId);
    return AsyncResult.success({ sequence: 1 });
  });
  const deletion = deleteSelectedThreadEntries({
    entries,
    delete: ({ threadRef }, deletedThreadKeys, deferDeletion) =>
      actions.deleteThread(threadRef, { deletedThreadKeys, deferDeletion }),
  });
  await cleanupStarted;
  expect(deleted).toEqual([]);
  expect(removals).toEqual(["/repo/one", "/repo/two", "/repo/three"]);
  expect(mocks.confirm).not.toHaveBeenCalled();
  finishCleanup();
  expect((await deletion).deletedThreadKeys.size).toBe(3);
});

it.each([false, true])(
  "removes a shared worktree only if all its threads were deleted (failure=%s)",
  async (failFirst) => {
    mocks.readThreadShell.mockImplementation(({ threadId }) => ({
      ...threads.find((thread) => thread.id === threadId),
      worktreePath: "/repo/shared",
    }));
    mocks.run.mockImplementation(async (label, { input }) =>
      failFirst && label.endsWith(":thread:delete") && input.threadId === "one"
        ? AsyncResult.failure(Cause.fail(new Error("delete failed")))
        : AsyncResult.success({ sequence: 1 }),
    );
    await deleteSelectedThreadEntries({
      entries,
      delete: ({ threadRef }, deletedThreadKeys, deferDeletion) =>
        actions.deleteThread(threadRef, { deletedThreadKeys, deferDeletion }),
    });
    expect(
      mocks.run.mock.calls.filter(
        ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
      ),
    ).toHaveLength(failFirst ? 0 : 1);
  },
);

it("does not repeat a worktree confirmation already included in the bulk confirmation", async () => {
  mocks.confirmThreadDelete = true;
  act(() => renderer.update(<Probe />));
  await actions.deleteThread(entries[0]!.threadRef, { worktreeDeletionConfirmed: true });
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(
    mocks.run.mock.calls.some(
      ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
    ),
  ).toBe(true);
});

it("still offers to keep a worktree for single deletion when confirmations are on", async () => {
  mocks.confirmThreadDelete = true;
  mocks.confirm.mockResolvedValue(false);
  act(() => renderer.update(<Probe />));
  await actions.deleteThread(entries[0]!.threadRef);
  expect(mocks.confirm).toHaveBeenCalledOnce();
  expect(mocks.run.mock.calls.some(([label]) => label.endsWith(":thread:delete"))).toBe(true);
  expect(
    mocks.run.mock.calls.some(
      ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
    ),
  ).toBe(false);
});

it.each([false, true])(
  "respects automatic cleanup with confirmations enabled=%s",
  async (confirmations) => {
    mocks.automaticCleanup = true;
    mocks.confirmThreadDelete = confirmations;
    appAtomRegistry.refresh(environmentServerConfigsAtom);
    act(() => renderer.update(<Probe />));
    expect((await actions.deleteThread(entries[0]!.threadRef))._tag).toBe("Success");
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.run.mock.calls.find(([label]) => label.endsWith(":thread:delete"))?.[1]).toEqual({
      environmentId,
      input: {
        threadId: threads[0]!.id,
        ...(!confirmations ? { deleteWorktreePath: "/repo/one" } : {}),
      },
    });
  },
);

it("keeps a worktree still used by an archived thread", async () => {
  mocks.archived.mockResolvedValue(
    AsyncResult.success({
      threads: [{ id: ThreadId.make("archived"), worktreePath: "/repo/one" }],
    }),
  );
  await actions.deleteThread(entries[0]!.threadRef);
  expect(
    mocks.run.mock.calls.some(
      ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
    ),
  ).toBe(false);
});

it.each([false, true])(
  "uses recoverable deletion for an archived target (failure=%s)",
  async (fail) => {
    mocks.readThreadShell.mockReturnValue(null);
    mocks.archived.mockResolvedValue(AsyncResult.success({ threads: [threads[0]] }));
    const deletion = fail
      ? AsyncResult.failure(Cause.fail(new Error("worktree locked")))
      : AsyncResult.success({ sequence: 1 });
    mocks.run.mockImplementation(async (label) =>
      label.endsWith(":thread:delete") ? deletion : AsyncResult.success({ sequence: 1 }),
    );

    expect(await actions.deleteThread(entries[0]!.threadRef)).toBe(deletion);
    expect(mocks.run.mock.calls.find(([label]) => label.endsWith(":thread:delete"))?.[1]).toEqual({
      environmentId,
      input: { threadId: threads[0]!.id, deleteWorktreePath: "/repo/one" },
    });
    expect(mocks.confirm).not.toHaveBeenCalled();
  },
);

it("keeps an archived target's worktree when another archived thread shares it", async () => {
  mocks.readThreadShell.mockReturnValue(null);
  mocks.archived.mockResolvedValue(
    AsyncResult.success({
      threads: [threads[0], { ...threads[1], worktreePath: "/repo/one" }],
    }),
  );
  await actions.deleteThread(entries[0]!.threadRef);
  expect(mocks.run.mock.calls.find(([label]) => label.endsWith(":thread:delete"))?.[1]).toEqual({
    environmentId,
    input: { threadId: threads[0]!.id },
  });
});

it("does not delete an unresolved target when its archived shell cannot be loaded", async () => {
  mocks.readThreadShell.mockReturnValue(null);
  mocks.archived.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
  expect((await actions.deleteThread(entries[0]!.threadRef))._tag).toBe("Failure");
  expect(mocks.run).not.toHaveBeenCalled();
});

it("keeps the conversation if archived threads cannot be checked", async () => {
  mocks.archived.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("offline"))));
  const result = await actions.deleteThread(entries[0]!.threadRef);
  expect(result._tag).toBe("Failure");
  expect(
    mocks.run.mock.calls.some(
      ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
    ),
  ).toBe(false);
  expect(mocks.run.mock.calls.some(([label]) => label.endsWith(":thread:delete"))).toBe(false);
});

it("rechecks live references before deferred cleanup", async () => {
  let cleanup: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  await actions.deleteThread(entries[0]!.threadRef, {
    deferDeletion: (run) => {
      cleanup = run;
    },
  });
  mocks.readThreadShell.mockImplementation(({ threadId }) => ({
    ...threads.find((thread) => thread.id === threadId),
    worktreePath: "/repo/one",
  }));
  await cleanup!();
  expect(
    mocks.run.mock.calls.some(
      ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
    ),
  ).toBe(false);
});

it("keeps a failed worktree's thread, finishes other deletions, and allows retry", async () => {
  const failure = AsyncResult.failure(Cause.fail(new Error("worktree is locked")));
  mocks.run.mockImplementation(async (label, { input }) =>
    label.endsWith(":thread:delete") &&
    input.deleteWorktreePath &&
    input.deleteWorktreePath === "/repo/two"
      ? failure
      : AsyncResult.success({ sequence: 1 }),
  );
  const result = await deleteSelectedThreadEntries({
    entries,
    delete: ({ threadRef }, deletedThreadKeys, deferDeletion) =>
      actions.deleteThread(threadRef, { deletedThreadKeys, deferDeletion }),
  });
  expect(result.firstFailure).toBe(failure);
  expect(result.deletedThreadKeys).toEqual(new Set([entries[0]!.threadKey, entries[2]!.threadKey]));
  expect(
    mocks.run.mock.calls
      .filter(([label]) => label.endsWith(":thread:delete"))
      .map(([, { input }]) => input.threadId),
  ).toEqual(["one", "two", "three"]);
  expect(
    mocks.run.mock.calls
      .filter(([label]) => label.includes("terminal") && label.endsWith(":close"))
      .every(([, { input }]) => input.deleteHistory === false),
  ).toBe(true);
  mocks.run.mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  expect((await actions.deleteThread(entries[1]!.threadRef))._tag).toBe("Success");
  expect(
    mocks.run.mock.calls
      .filter(([label]) => label.endsWith(":thread:delete"))
      .map(([, { input }]) => input.threadId),
  ).toEqual(["one", "two", "three", "two"]);
});

it("shares an in-flight deletion when the same thread is deleted again", async () => {
  let finishCleanup!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  let startCleanup!: () => void;
  const started = new Promise<void>((resolve) => {
    startCleanup = resolve;
  });
  mocks.run.mockImplementation(async (label, { input }) => {
    if (label.endsWith(":thread:delete") && input.deleteWorktreePath) {
      startCleanup();
      await pending;
    }
    return AsyncResult.success({ sequence: 1 });
  });
  const first = actions.deleteThread(entries[0]!.threadRef);
  await started;
  const second = actions.deleteThread(entries[0]!.threadRef);
  finishCleanup();
  await Promise.all([first, second]);
  expect(
    mocks.run.mock.calls.filter(
      ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
    ),
  ).toHaveLength(1);
  expect(mocks.run.mock.calls.filter(([label]) => label.endsWith(":thread:delete"))).toHaveLength(
    1,
  );
});

it.each([":terminal:close", ":thread:stop-session"])(
  "keeps the thread and files if %s fails",
  async (failedOperation) => {
    mocks.readThreadShell.mockImplementation(({ threadId }) => {
      const thread = threads.find((thread) => thread.id === threadId);
      return thread ? { ...thread, session: { status: "ready" } } : null;
    });
    mocks.run.mockImplementation(async (label) =>
      label.endsWith(failedOperation)
        ? AsyncResult.failure(Cause.fail(new Error("stop failed")))
        : AsyncResult.success({ sequence: 1 }),
    );
    expect((await actions.deleteThread(entries[0]!.threadRef))._tag).toBe("Failure");
    expect(
      mocks.run.mock.calls.some(
        ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
      ),
    ).toBe(false);
    expect(mocks.run.mock.calls.some(([label]) => label.endsWith(":thread:delete"))).toBe(false);
  },
);

it("rechecks shared references when a queued repository deletion actually starts", async () => {
  let finishFirst!: () => void;
  const firstPending = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let startFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    startFirst = resolve;
  });
  let scheduleSecond!: () => void;
  const secondScheduled = new Promise<void>((resolve) => {
    scheduleSecond = resolve;
  });
  mocks.run.mockImplementation(async (label, { input }) => {
    if (
      label.endsWith(":thread:delete") &&
      input.deleteWorktreePath &&
      input.deleteWorktreePath === "/repo/one"
    ) {
      startFirst();
      await firstPending;
    }
    return AsyncResult.success({ sequence: 1 });
  });
  const deletion = deleteSelectedThreadEntries({
    entries: entries.slice(0, 2),
    delete: async ({ threadRef }, deletedThreadKeys, deferDeletion) => {
      const result = await actions.deleteThread(threadRef, { deletedThreadKeys, deferDeletion });
      if (threadRef.threadId === "two") scheduleSecond();
      return result;
    },
  });
  await Promise.all([firstStarted, secondScheduled]);
  mocks.readThreadShell.mockImplementation(({ threadId }) => {
    const thread = threads.find((entry) => entry.id === threadId);
    return threadId === "three" ? { ...thread, worktreePath: "/repo/two" } : thread;
  });
  finishFirst();
  expect((await deletion).deletedThreadKeys.size).toBe(2);
  expect(
    mocks.run.mock.calls
      .filter(([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath)
      .map(([, { input }]) => input.deleteWorktreePath),
  ).toEqual(["/repo/one"]);
});

it("retains a thread that changes worktrees while its reference check is pending", async () => {
  let finishCheck!: (result: ReturnType<typeof AsyncResult.success<{ threads: [] }>>) => void;
  const pending = new Promise<ReturnType<typeof AsyncResult.success<{ threads: [] }>>>(
    (resolve) => {
      finishCheck = resolve;
    },
  );
  let startCheck!: () => void;
  const started = new Promise<void>((resolve) => {
    startCheck = resolve;
  });
  mocks.archived.mockImplementation(() => {
    startCheck();
    return pending;
  });
  const deletion = actions.deleteThread(entries[0]!.threadRef);
  await started;
  mocks.readThreadShell.mockImplementation(({ threadId }) => {
    const thread = threads.find((entry) => entry.id === threadId);
    return threadId === "one"
      ? { ...thread, worktreePath: "/repo/new" }
      : { ...thread, worktreePath: "/repo/one" };
  });
  finishCheck(AsyncResult.success({ threads: [] }));
  expect((await deletion)._tag).toBe("Failure");
  expect(
    mocks.run.mock.calls.some(
      ([label, { input }]) => label.endsWith(":thread:delete") && input.deleteWorktreePath,
    ),
  ).toBe(false);
  expect(mocks.run.mock.calls.some(([label]) => label.endsWith(":thread:delete"))).toBe(false);
});

it("keeps the session and terminal running when an older server cannot delete the worktree", async () => {
  mocks.recoverableDeletion = false;
  mocks.readThreadShell.mockImplementation(({ threadId }) => {
    const thread = threads.find((entry) => entry.id === threadId);
    return thread ? { ...thread, session: { status: "ready" } } : null;
  });
  const result = await actions.deleteThread(entries[0]!.threadRef);
  expect(result._tag).toBe("Failure");
  expect(mocks.run).not.toHaveBeenCalled();
});

it("still deletes on an older server when refreshed references require keeping the worktree", async () => {
  mocks.recoverableDeletion = false;
  mocks.archived.mockResolvedValue(
    AsyncResult.success({
      threads: [{ id: ThreadId.make("archived"), worktreePath: "/repo/one" }],
    }),
  );
  expect((await actions.deleteThread(entries[0]!.threadRef))._tag).toBe("Success");
  expect(mocks.run.mock.calls.find(([label]) => label.endsWith(":thread:delete"))?.[1]).toEqual({
    environmentId,
    input: { threadId: threads[0]!.id },
  });
});

it("reports committed deletion separately from pending cleanup and retries only cleanup", async () => {
  const pending = { cwd: "/repo", path: "/repo/.t3-delete-test" };
  mocks.run.mockImplementation(async (label) =>
    label.endsWith(":thread:delete")
      ? AsyncResult.success({
          sequence: 1,
          worktreeCleanupPending: { ...pending, retryable: true },
        })
      : AsyncResult.success({ sequence: 1 }),
  );
  const outcome = await actions.deleteThread(entries[0]!.threadRef);
  expect(outcome._tag).toBe("Success");
  const toast = mocks.toastAdd.mock.calls[0]![0];
  expect(toast.title).toBe("Thread deleted; worktree cleanup incomplete");
  expect(toast.description).toContain(pending.path);
  await toast.actionProps!.onClick();
  expect(mocks.run.mock.calls.filter(([label]) => label.endsWith(":thread:delete"))).toHaveLength(
    1,
  );
  expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining(":remove-worktree"), {
    environmentId,
    input: { ...pending, force: true },
  });
  expect(mocks.toastClose).toHaveBeenCalledWith("cleanup-toast");
  expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining(":refresh-status"), {
    environmentId,
    input: { cwd: "/repo" },
  });
});

it("does not offer destructive retry when cleanup could not be verified", async () => {
  mocks.run.mockResolvedValue(
    AsyncResult.success({
      sequence: 1,
      worktreeCleanupPending: { cwd: "/repo", path: "/repo/.t3-delete-test", retryable: false },
    }),
  );
  expect((await actions.deleteThread(entries[0]!.threadRef))._tag).toBe("Success");
  const toast = mocks.toastAdd.mock.calls[0]![0];
  expect(toast.description).toContain("cleanup could not be verified");
  expect(toast.actionProps).toBeUndefined();
});
