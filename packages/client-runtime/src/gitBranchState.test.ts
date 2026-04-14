import type { GitListBranchesResult } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createGitBranchManager,
  EMPTY_GIT_BRANCH_STATE,
  gitBranchStateAtom,
  type GitBranchClient,
} from "./gitBranchState";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

const TARGET = { environmentId: "env-local", cwd: "/repo" } as const;

const FIRST_PAGE: GitListBranchesResult = {
  branches: [
    { name: "main", current: true, isDefault: true, worktreePath: null },
    { name: "feature/a", current: false, isDefault: false, worktreePath: null },
  ],
  isRepo: true,
  hasOriginRemote: true,
  nextCursor: 2,
  totalCount: 3,
};

const SECOND_PAGE: GitListBranchesResult = {
  branches: [{ name: "feature/b", current: false, isDefault: false, worktreePath: null }],
  isRepo: true,
  hasOriginRemote: true,
  nextCursor: null,
  totalCount: 3,
};

function createMockClient() {
  const listBranches = vi.fn(async (input: Parameters<GitBranchClient["listBranches"]>[0]) => {
    if (input.query === "feature") {
      return {
        ...FIRST_PAGE,
        branches: FIRST_PAGE.branches.filter((branch) => branch.name.includes("feature")),
        nextCursor: null,
        totalCount: 2,
      } satisfies GitListBranchesResult;
    }

    if (input.cursor === 2) {
      return SECOND_PAGE;
    }

    return FIRST_PAGE;
  });

  return {
    client: { listBranches } satisfies GitBranchClient,
    listBranches,
  };
}

describe("createGitBranchManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("loads the first page and stores it in atom state", async () => {
    const mock = createMockClient();
    const manager = createGitBranchManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
    });

    const promise = manager.load(TARGET, mock.client, { limit: 100 });

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: null,
      isPending: true,
      error: null,
    });

    await expect(promise).resolves.toEqual(FIRST_PAGE);
    expect(manager.getSnapshot(TARGET)).toEqual({
      data: FIRST_PAGE,
      isPending: false,
      error: null,
    });
    expect(mock.listBranches).toHaveBeenCalledWith({ cwd: "/repo", limit: 100 });
  });

  it("loads the next page and appends branches", async () => {
    const mock = createMockClient();
    const manager = createGitBranchManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
    });

    await manager.load(TARGET, mock.client);
    const next = await manager.loadNext(TARGET, mock.client);

    expect(next).toEqual({
      ...SECOND_PAGE,
      branches: [...FIRST_PAGE.branches, ...SECOND_PAGE.branches],
    });
    expect(manager.getSnapshot(TARGET)).toEqual({
      data: {
        ...SECOND_PAGE,
        branches: [...FIRST_PAGE.branches, ...SECOND_PAGE.branches],
      },
      isPending: false,
      error: null,
    });
  });

  it("stores query-specific state independently", async () => {
    const mock = createMockClient();
    const manager = createGitBranchManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
    });

    const queriedTarget = { ...TARGET, query: "feature" } as const;
    const queried = await manager.load(queriedTarget, mock.client);

    expect(queried?.branches.map((branch) => branch.name)).toEqual(["feature/a"]);
    expect(manager.getSnapshot(TARGET).data).toBeNull();
    expect(manager.getSnapshot(queriedTarget).data?.branches.map((branch) => branch.name)).toEqual([
      "feature/a",
    ]);
  });

  it("returns cached data when no client is available", async () => {
    const manager = createGitBranchManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    atomRegistry.set(gitBranchStateAtom("env-local:/repo:"), {
      data: FIRST_PAGE,
      isPending: false,
      error: null,
    });

    await expect(manager.load(TARGET)).resolves.toEqual(FIRST_PAGE);
  });

  it("resets state", async () => {
    const mock = createMockClient();
    const manager = createGitBranchManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
    });

    await manager.load(TARGET, mock.client);
    manager.reset();

    expect(manager.getSnapshot(TARGET)).toEqual(EMPTY_GIT_BRANCH_STATE);
  });
});
