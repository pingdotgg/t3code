import { act, useEffect, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { VcsListRefsResult } from "@t3tools/contracts";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { resolveAutoFeatureBranchName } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  selection: {
    selectedThread: { environmentId: "environment-1", id: "thread-1" } as unknown,
    selectedThreadProject: { workspaceRoot: "/repo" } as unknown,
    selectedEnvironmentRuntime: { connectionState: "connected" } as unknown,
  },
  worktree: { selectedThreadCwd: "/repo" as string | null, selectedThreadWorktreePath: null },
  refreshStatusCalls: [] as Array<unknown>,
  renderCount: 0,
  onRefreshSettled: () => {},
  branchAtom: null as Atom.Atom<AsyncResult.AsyncResult<VcsListRefsResult, unknown>> | null,
  refsQueryAtom: null as Atom.Atom<AsyncResult.AsyncResult<VcsListRefsResult, unknown>> | null,
  listRefs: vi.fn(),
  refsQuery: vi.fn(),
  showGitActionResult: vi.fn(),
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === "refreshStatus"
      ? async (input: unknown) => {
          harness.refreshStatusCalls.push(input);
          harness.onRefreshSettled();
          return AsyncResult.success({});
        }
      : async () => AsyncResult.success({}),
}));
vi.mock("./vcs", () => ({
  vcsEnvironment: { refreshStatus: "refreshStatus", listRefs: harness.listRefs },
  vcsRefsQuery: harness.refsQuery,
  vcsActionManager: { runStackedAction: () => "runStackedAction", track: vi.fn() },
}));
vi.mock("./threads", () => ({ threadEnvironment: { updateMetadata: "updateMetadata" } }));
vi.mock("./queries", () => ({ useBranches: () => ({ data: null, refresh: () => {} }) }));
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid" }));
vi.mock("./atom-registry", async () => ({
  appAtomRegistry: (await import("effect/reactivity")).AtomRegistry.make(),
}));
vi.mock("./session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock("./use-remote-environment-registry", () => ({ setPendingConnectionError: () => {} }));
vi.mock("./use-vcs-action-state", () => ({ showGitActionResult: harness.showGitActionResult }));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => {
    harness.renderCount += 1;
    if (harness.renderCount > 50) {
      throw new Error("Consumer rerendered more than 50 times");
    }
    return harness.selection;
  },
}));
vi.mock("./use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => harness.worktree,
}));

import { useSelectedThreadGitActions } from "./use-selected-thread-git-actions";
import { appAtomRegistry } from "./atom-registry";

let root: Root | null = null;
let rerender: () => void = () => {};
let actions: ReturnType<typeof useSelectedThreadGitActions>;

function Consumer() {
  const [, bump] = useReducer((count: number) => count + 1, 0);
  const gitActions = useSelectedThreadGitActions();
  useEffect(() => {
    rerender = bump;
    actions = gitActions;
  });
  return null;
}

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.selection = {
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
    selectedThreadProject: { workspaceRoot: "/repo" },
    selectedEnvironmentRuntime: { connectionState: "connected" },
  };
  harness.worktree = { selectedThreadCwd: "/repo", selectedThreadWorktreePath: null };
  harness.refreshStatusCalls = [];
  harness.renderCount = 0;
  harness.onRefreshSettled = () => rerender();
  harness.listRefs.mockReset().mockImplementation(() => harness.branchAtom);
  harness.refsQuery.mockReset().mockImplementation(() => harness.refsQueryAtom);
  harness.showGitActionResult.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

afterAll(() => appAtomRegistry.dispose());

describe("useSelectedThreadGitActions", () => {
  it.each([false, true])(
    "waits for fresh refs before naming a branch, cached: %s",
    async (cached) => {
      const request = Promise.withResolvers<VcsListRefsResult>();
      const empty: VcsListRefsResult = {
        refs: [],
        isRepo: true,
        hasPrimaryRemote: true,
        nextCursor: null,
        totalCount: 0,
      };
      let response = cached ? Promise.resolve(empty) : request.promise;
      const fetchRefs = Effect.tryPromise(() => response);
      harness.branchAtom = Atom.make(
        Stream.concat(Stream.fromEffect(fetchRefs), Stream.never),
      ).pipe(Atom.keepAlive);
      harness.refsQueryAtom = Atom.make(fetchRefs).pipe(Atom.keepAlive);
      appAtomRegistry.get(harness.branchAtom);
      if (cached) {
        await vi.waitFor(() =>
          expect(appAtomRegistry.get(harness.branchAtom)._tag).toBe("Success"),
        );
        expect(appAtomRegistry.get(harness.branchAtom).waiting).toBe(true);
        await executeAtomQuery(appAtomRegistry, harness.refsQueryAtom);
        response = request.promise;
      }
      root = createRoot(document.createElement("div"));
      act(() => root!.render(<Consumer />));

      let settled = false;
      const refresh = actions.refreshSelectedThreadBranches().then((branches) => {
        settled = true;
        return branches;
      });
      await flush();
      expect(settled).toBe(false);
      const local = {
        name: "feature/update",
        isRemote: false,
        current: false,
        isDefault: false,
        worktreePath: null,
      };
      request.resolve({
        refs: [
          local,
          { ...local, name: "origin/feature/update", isRemote: true, remoteName: "origin" },
        ],
        nextCursor: null,
        isRepo: true,
        hasPrimaryRemote: true,
        totalCount: 2,
      });
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(appAtomRegistry.get(harness.branchAtom)).toMatchObject({
        _tag: "Success",
        waiting: true,
      });
      const branches = await refresh;
      expect(harness.refsQuery).toHaveBeenCalledWith({
        environmentId: "environment-1",
        input: { cwd: "/repo", limit: 100 },
      });
      expect(branches).toEqual([local]);
      expect(resolveAutoFeatureBranchName(branches!.map((branch) => branch.name))).toBe(
        "feature/update-2",
      );
    },
  );

  it("reports a failed ref refresh instead of returning an empty list for branch creation", async () => {
    const request = Promise.withResolvers<VcsListRefsResult>();
    void request.promise.catch(() => {});
    harness.branchAtom = Atom.make(
      Effect.tryPromise({
        try: () => request.promise,
        catch: (error) => error,
      }),
    );
    harness.refsQueryAtom = harness.branchAtom;
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Consumer />));
    const refresh = actions.refreshSelectedThreadBranches();
    request.reject(new Error("Cannot list refs"));
    expect(await refresh).toBeNull();
    expect(harness.showGitActionResult).toHaveBeenCalledWith({
      type: "error",
      title: "Git action failed",
      description: "Cannot list refs",
    });
  });

  it("refreshes once on mount and does not loop when refreshes rerender the consumer", async () => {
    root = createRoot(document.createElement("div"));
    act(() => root!.render(<Consumer />));
    await flush();

    harness.selection = {
      selectedThread: { environmentId: "environment-1", id: "thread-1" },
      selectedThreadProject: { workspaceRoot: "/repo" },
      selectedEnvironmentRuntime: { connectionState: "connected" },
    };
    act(() => rerender());
    await flush();

    expect(harness.refreshStatusCalls).toEqual([
      { environmentId: "environment-1", input: { cwd: "/repo" } },
    ]);
  });
});
