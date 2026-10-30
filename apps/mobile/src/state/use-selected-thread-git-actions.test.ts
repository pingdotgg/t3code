import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import type { VcsListRefsResult } from "@t3tools/contracts";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
  branch: "main",
  worktrees: [] as string[],
  thread: {
    id: "thread",
    environmentId: "environment",
    branch: "main",
    worktreePath: null as string | null,
  },
  commits: 0,
  pushes: 0,
  metadataRequests: [] as { environmentId: string; branch: string }[],
  results: [] as { type: string; description?: string }[],
  afterGitAction: undefined as (() => void) | undefined,
  statusRefreshes: 0,
  readRefs: vi.fn(),
  cachedRefs: [] as VcsListRefsResult["refs"],
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomMount: () => {} }));
vi.mock("./session", () => ({
  useEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === state.thread.environmentId ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === state.thread.environmentId ? state.scopes : state.primaryScopes).has(scope),
}));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: state.thread,
    selectedThreadProject: { workspaceRoot: "/repo" },
  }),
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/repo",
    selectedThreadWorktreePath: null,
  }),
}));
vi.mock("./queries", () => ({
  useBranches: () => ({ data: { refs: state.cachedRefs }, refresh: () => {} }),
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./use-remote-environment-registry", () => ({
  environmentConnectedAtom: () => null,
  setPendingConnectionError: () => {},
}));
vi.mock("./use-vcs-action-state", () => ({
  showGitActionResult: (result: { type: string; description?: string }) =>
    state.results.push(result),
}));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "action" }));
vi.mock("./threads", () => ({
  threadEnvironment: {
    updateMetadata: async ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: { branch: string; worktreePath: string | null };
    }) => {
      state.metadataRequests.push({ environmentId, branch: input.branch });
      if (!state.scopes.has(AuthOrchestrationOperateScope)) {
        return AsyncResult.failure(Cause.fail(new Error("Task operation denied")));
      }
      Object.assign(state.thread, input);
      return AsyncResult.success(undefined);
    },
  },
}));
vi.mock("./vcs", () => ({
  vcsEnvironment: {
    readRefs: state.readRefs,
    refreshStatus: async () => {
      state.statusRefreshes += 1;
      return AsyncResult.success({ refName: state.branch });
    },
    switchRef: async ({ input }: { input: { refName: string } }) => {
      state.branch = input.refName;
      state.afterGitAction?.();
      return AsyncResult.success({ refName: state.branch });
    },
    createRef: async ({ input }: { input: { refName: string } }) => {
      state.branch = input.refName;
      state.afterGitAction?.();
      return AsyncResult.success({ refName: state.branch });
    },
    createWorktree: async ({ input }: { input: { newRefName: string } }) => {
      state.worktrees.push("/repo-worktree");
      state.afterGitAction?.();
      return AsyncResult.success({
        worktree: { path: "/repo-worktree", refName: input.newRefName },
      });
    },
    pull: async () => AsyncResult.success({ status: "pulled", refName: state.branch }),
  },
  vcsActionManager: {
    track: (_registry: unknown, _target: unknown, _operation: unknown, run: () => unknown) => run(),
    runStackedAction: () => async (input: { action: string; featureBranch?: boolean }) => {
      if (input.featureBranch) state.branch = "feature";
      if (input.action === "commit") state.commits += 1;
      if (input.action === "push") state.pushes += 1;
      state.afterGitAction?.();
      return AsyncResult.success({
        branch: input.featureBranch
          ? { status: "created", name: "feature" }
          : { status: "skipped_not_requested" },
        toast: { title: "Done", description: "Done", cta: { kind: "none" } },
      });
    },
  },
}));

import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";

describe("thread Git mutation permissions", () => {
  beforeEach(() => {
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.primaryScopes = new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope]);
    state.branch = "main";
    state.worktrees = [];
    state.thread.branch = "main";
    state.thread.worktreePath = null;
    state.commits = 0;
    state.pushes = 0;
    state.metadataRequests = [];
    state.results = [];
    state.afterGitAction = undefined;
    state.statusRefreshes = 0;
  });

  it.each([false, true])(
    "requires task permission before creating and attaching a worktree: %s",
    async (canOperate) => {
      if (canOperate) state.scopes.add(AuthOrchestrationOperateScope);
      const actions = useSelectedThreadGitActions();
      const result = await actions.onCreateSelectedThreadWorktree({
        baseBranch: "main",
        newBranch: "feature/task",
      });
      expect(result).toEqual(
        canOperate ? { worktree: { path: "/repo-worktree", refName: "feature/task" } } : null,
      );
      expect(state.worktrees).toEqual(canOperate ? ["/repo-worktree"] : []);
      expect(state.thread.worktreePath).toBe(canOperate ? "/repo-worktree" : null);
      expect(state.thread.branch).toBe(canOperate ? "feature/task" : "main");
    },
  );

  it("keeps ordinary commits and pushes available without task permission", async () => {
    const actions = useSelectedThreadGitActions();
    await actions.onRunSelectedThreadGitAction({ action: "commit" });
    await actions.onRunSelectedThreadGitAction({ action: "push" });
    expect(state.commits).toBe(1);
    expect(state.pushes).toBe(1);
    expect(state.thread.branch).toBe("main");
    expect(state.metadataRequests).toEqual([]);
  });

  it.each(["create", "checkout", "worktree", "commit"] as const)(
    "does not send thread metadata after task permission is revoked during %s",
    async (operation) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(AuthOrchestrationOperateScope);
      const actions = useSelectedThreadGitActions();
      if (operation === "create")
        expect(await actions.onCreateSelectedThreadBranch("feature")).toBeNull();
      if (operation === "checkout")
        expect(await actions.onCheckoutSelectedThreadBranch("feature")).toBeNull();
      if (operation === "worktree")
        expect(
          await actions.onCreateSelectedThreadWorktree({
            baseBranch: "main",
            newBranch: "feature",
          }),
        ).toBeNull();
      if (operation === "commit")
        expect(
          await actions.onRunSelectedThreadGitAction({ action: "commit", featureBranch: true }),
        ).toBeNull();
      if (operation === "worktree") expect(state.worktrees).toEqual(["/repo-worktree"]);
      else expect(state.branch).toBe("feature");
      expect(state.thread.branch).toBe("main");
      expect(state.thread.worktreePath).toBeNull();
      expect(state.metadataRequests).toEqual([]);
      expect(state.results.map((result) => result.type)).toEqual(["error"]);
    },
  );

  it("refreshes the worktree status when the metadata update is denied after checkout", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    state.afterGitAction = () => state.scopes.delete(AuthOrchestrationOperateScope);
    expect(
      await useSelectedThreadGitActions().onCheckoutSelectedThreadBranch("feature"),
    ).toBeNull();
    expect(state.branch).toBe("feature");
    expect(state.statusRefreshes).toBe(1);
  });

  it.each(["create", "checkout", "worktree"] as const)(
    "returns the accepted %s result when only source-control permission is revoked after Git",
    async (operation) => {
      state.scopes.add(AuthOrchestrationOperateScope);
      state.afterGitAction = () => state.scopes.delete(AuthSourceControlWriteScope);
      const actions = useSelectedThreadGitActions();
      const result =
        operation === "create"
          ? await actions.onCreateSelectedThreadBranch("feature/task")
          : operation === "checkout"
            ? await actions.onCheckoutSelectedThreadBranch("feature/task")
            : await actions.onCreateSelectedThreadWorktree({
                baseBranch: "main",
                newBranch: "feature/task",
              });
      expect(result).toEqual(
        operation === "worktree"
          ? { worktree: { path: "/repo-worktree", refName: "feature/task" } }
          : { refName: "feature/task" },
      );
      expect(state.thread.branch).toBe("feature/task");
      expect(state.metadataRequests).toHaveLength(1);
      expect(state.results).toEqual([]);
    },
  );
});

describe("automatic feature branch refs", () => {
  const empty: VcsListRefsResult = {
    refs: [],
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: 0,
  };

  it.each([false, true])("awaits fresh refs before naming, cached: %s", async (cached) => {
    const request = Promise.withResolvers<VcsListRefsResult>();
    state.cachedRefs = cached
      ? [
          {
            name: "old-branch",
            isRemote: false,
            current: false,
            isDefault: false,
            worktreePath: null,
          },
        ]
      : [];
    state.readRefs.mockReturnValue(request.promise.then(AsyncResult.success));
    let settled = false;
    const refresh = useSelectedThreadGitActions()
      .refreshSelectedThreadBranches()
      .then((refs) => {
        settled = true;
        return refs;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    const local = {
      name: "feature/update",
      isRemote: false,
      current: false,
      isDefault: false,
      worktreePath: null,
    };
    request.resolve({
      ...empty,
      refs: [
        local,
        { ...local, name: "origin/feature/update", isRemote: true, remoteName: "origin" },
      ],
      totalCount: 2,
    });
    const refs = await refresh;
    expect(refs).toEqual([local]);
    expect(resolveAutoFeatureBranchName(refs!.map((ref) => ref.name))).toBe("feature/update-2");
    expect(state.readRefs).toHaveBeenCalledWith({
      environmentId: "environment",
      input: { cwd: "/repo", limit: 100, refresh: true },
    });
  });

  it("reports lookup failure instead of returning empty refs", async () => {
    state.results = [];
    state.readRefs.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("Cannot list refs"))),
    );
    expect(await useSelectedThreadGitActions().refreshSelectedThreadBranches()).toBeNull();
    expect(state.results).toEqual([
      { type: "error", title: "Git action failed", description: "Cannot list refs" },
    ]);
  });
});
