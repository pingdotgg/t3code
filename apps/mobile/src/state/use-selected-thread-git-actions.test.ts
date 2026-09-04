import { AuthOrchestrationOperateScope, AuthSourceControlWriteScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
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
}));

vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => {},
}));
vi.mock("./session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) => state.scopes.has(scope),
  readEnvironmentScope: (_environmentId: unknown, scope: string) => state.scopes.has(scope),
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
  useBranches: () => ({ data: { refs: [] }, refresh: () => {} }),
}));
vi.mock("./use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: () => {} }));
vi.mock("./use-vcs-action-state", () => ({ showGitActionResult: () => {} }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "action" }));
vi.mock("./threads", () => ({
  threadEnvironment: {
    updateMetadata: async ({
      input,
    }: {
      input: { branch: string; worktreePath: string | null };
    }) => {
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
    refreshStatus: async () => AsyncResult.success({ refName: state.branch }),
    switchRef: async ({ input }: { input: { refName: string } }) => {
      state.branch = input.refName;
      return AsyncResult.success({ refName: state.branch });
    },
    createRef: async ({ input }: { input: { refName: string } }) => {
      state.branch = input.refName;
      return AsyncResult.success({ refName: state.branch });
    },
    createWorktree: async ({ input }: { input: { newRefName: string } }) => {
      state.worktrees.push("/repo-worktree");
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
    state.branch = "main";
    state.worktrees = [];
    state.thread.branch = "main";
    state.thread.worktreePath = null;
    state.commits = 0;
    state.pushes = 0;
  });

  it.each([false, true])(
    "requires task permission before creating and attaching a worktree: %s",
    async (canOperate) => {
      if (canOperate) state.scopes.add(AuthOrchestrationOperateScope);
      const actions = useSelectedThreadGitActions();
      await actions.onCreateSelectedThreadWorktree({
        baseBranch: "main",
        newBranch: "feature/task",
      });
      expect(state.worktrees).toEqual(canOperate ? ["/repo-worktree"] : []);
      expect(state.thread.worktreePath).toBe(canOperate ? "/repo-worktree" : null);
      expect(state.thread.branch).toBe(canOperate ? "feature/task" : "main");
    },
  );

  it.each(["create", "checkout", "commit on new branch"] as const)(
    "requires task permission before %s",
    async (operation) => {
      const actions = useSelectedThreadGitActions();
      if (operation === "create") {
        expect(await actions.onCreateSelectedThreadBranch("feature")).toBeNull();
      }
      if (operation === "checkout") await actions.onCheckoutSelectedThreadBranch("feature");
      if (operation === "commit on new branch")
        await actions.onRunSelectedThreadGitAction({ action: "commit", featureBranch: true });
      expect(state.branch).toBe("main");
      expect(state.thread.branch).toBe("main");
      expect(state.commits).toBe(0);
    },
  );

  it("rechecks task permission when a retained menu callback runs", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    const actions = useSelectedThreadGitActions();
    state.scopes.delete(AuthOrchestrationOperateScope);
    await actions.onCreateSelectedThreadWorktree({ baseBranch: "main", newBranch: "feature/task" });
    expect(state.worktrees).toEqual([]);
    expect(state.thread.worktreePath).toBeNull();
  });

  it("keeps ordinary commits and pushes available without task permission", async () => {
    const actions = useSelectedThreadGitActions();
    await actions.onRunSelectedThreadGitAction({ action: "commit" });
    await actions.onRunSelectedThreadGitAction({ action: "push" });
    expect(state.commits).toBe(1);
    expect(state.pushes).toBe(1);
    expect(state.thread.branch).toBe("main");
  });
});
