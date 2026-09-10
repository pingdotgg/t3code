import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadDiffPanelSelection,
  selectThreadDiffRepositoryPath,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
// Its scoped key starts with the one above, which a prefix match must not treat
// as the same thread.
const SIMILAR_THREAD_REF = scopeThreadRef(
  EnvironmentId.make("environment-1"),
  ThreadId.make("thread-10"),
);
const NESTED_REPOSITORY = "services/api";
const CONFIGURED_REPOSITORIES = [{ path: "." }, { path: NESTED_REPOSITORY }];
const NESTED_FIRST_REPOSITORIES = [{ path: NESTED_REPOSITORY }, { path: "." }];

const selectionFor = (
  ref: typeof THREAD_REF,
  repositoryPath: string | null = null,
  hasWorkingTreeChanges = false,
) =>
  selectThreadDiffPanelSelection(
    useDiffPanelStore.getState().byThreadKey,
    ref,
    repositoryPath,
    hasWorkingTreeChanges,
  );

const repositoryFor = (
  ref: typeof THREAD_REF,
  configuredRepositories: ReadonlyArray<{ readonly path: string }> = CONFIGURED_REPOSITORIES,
) =>
  selectThreadDiffRepositoryPath(
    useDiffPanelStore.getState().selectedRepositoryByThreadKey,
    ref,
    configuredRepositories,
  );

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectedRepositoryByThreadKey: {},
    }),
  );

  it("defaults each thread to branch changes when the working tree is clean", () => {
    expect(selectionFor(THREAD_REF)).toEqual({ kind: "branch", baseRef: null });
  });

  it("defaults each thread to working changes when the working tree is dirty", () => {
    expect(selectionFor(THREAD_REF, null, true)).toEqual({ kind: "unstaged" });
  });

  it("preserves an explicit scope selection when the working tree state changes", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch", null);

    expect(selectionFor(THREAD_REF, null, true)).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, TurnId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged", null);

    expect(selectionFor(THREAD_REF)).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ", null);
    expect(selectionFor(THREAD_REF)).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = TurnId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(selectionFor(THREAD_REF)).toEqual({
      kind: "turn",
      turnId,
      filePath: "src/app.ts",
      revealRequestId: 2,
    });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main", null);
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged", null);
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch", null);

    expect(selectionFor(THREAD_REF)).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = TurnId.make("turn-missing");
    const latestTurnId = TurnId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(selectionFor(THREAD_REF)).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
  });

  it("keeps a branch base per repository across repository switches", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main", null);
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/api", NESTED_REPOSITORY);

    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({
      kind: "branch",
      baseRef: "origin/api",
    });
    expect(selectionFor(THREAD_REF, null)).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("starts a newly selected repository from the default instead of the previous base", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main", null);

    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({ kind: "branch", baseRef: null });
  });

  it("keeps scopes separate per repository", () => {
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged", NESTED_REPOSITORY);

    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({ kind: "unstaged" });
    expect(selectionFor(THREAD_REF, null)).toEqual({ kind: "branch", baseRef: null });
  });

  it("reads state persisted before repositories as the default repository", () => {
    // State written before the panel knew about repositories lives on the bare
    // thread key and has to stay readable without a migration. It represents
    // the workspace root, while configured repositories use their actual paths.
    useDiffPanelStore.setState({
      byThreadKey: {
        [scopedThreadKey(THREAD_REF)]: { kind: "branch", baseRef: "origin/persisted" },
      },
    });

    expect(selectionFor(THREAD_REF, null)).toEqual({ kind: "branch", baseRef: "origin/persisted" });

    // Writing the workspace root updates that same persisted entry.
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main", null);
    expect(useDiffPanelStore.getState().byThreadKey[scopedThreadKey(THREAD_REF)]).toEqual({
      kind: "branch",
      baseRef: "origin/main",
    });
  });

  it("keeps an explicitly picked workspace root apart from the default repository", () => {
    // A workspace configured as [{ path: "services/api" }, { path: "." }] keeps
    // the nested default on its own key, while "." normalizes to the workspace key.
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/api", NESTED_REPOSITORY);
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/root", null);

    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({
      kind: "branch",
      baseRef: "origin/api",
    });
    expect(selectionFor(THREAD_REF, null)).toEqual({ kind: "branch", baseRef: "origin/root" });
  });

  it("uses the configured default path and keeps its base ref when repositories reorder", () => {
    // The panel records the resolved default path when the user first edits its
    // scope, so a later t3.json reorder keeps addressing the same repository.
    useDiffPanelStore.getState().selectRepository(THREAD_REF, NESTED_REPOSITORY);
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/api", NESTED_REPOSITORY);

    expect(repositoryFor(THREAD_REF, NESTED_FIRST_REPOSITORIES)).toBe(NESTED_REPOSITORY);
    expect(selectionFor(THREAD_REF, repositoryFor(THREAD_REF, NESTED_FIRST_REPOSITORIES))).toEqual({
      kind: "branch",
      baseRef: "origin/api",
    });
    expect(repositoryFor(THREAD_REF, CONFIGURED_REPOSITORIES)).toBe(NESTED_REPOSITORY);
  });

  it("falls back to the new default without overwriting a removed repository's state", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/api", NESTED_REPOSITORY);
    const changedRepositories = [{ path: "backend" }];

    expect(repositoryFor(THREAD_REF, changedRepositories)).toBe("backend");
    expect(selectionFor(THREAD_REF, "backend")).toEqual({ kind: "branch", baseRef: null });
    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({
      kind: "branch",
      baseRef: "origin/api",
    });
  });

  it("selects a repository per thread", () => {
    useDiffPanelStore.getState().selectRepository(THREAD_REF, NESTED_REPOSITORY);

    expect(repositoryFor(THREAD_REF)).toBe(NESTED_REPOSITORY);
    expect(repositoryFor(SIMILAR_THREAD_REF)).toBe(null);
  });

  it("falls back to the default repository when the selection is no longer configured", () => {
    useDiffPanelStore.getState().selectRepository(THREAD_REF, "frontend");

    // t3.json is checked in, so "frontend" can disappear while the choice
    // persists — for instance after pulling a colleague's change.
    const repositoryPath = repositoryFor(THREAD_REF, CONFIGURED_REPOSITORIES);
    expect(repositoryPath).toBe(null);

    // The diff shown then belongs to the default repository, so its base ref has
    // to land there too instead of under the repository that is gone.
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main", repositoryPath);
    expect(selectionFor(THREAD_REF, null)).toEqual({ kind: "branch", baseRef: "origin/main" });
    expect(selectionFor(THREAD_REF, "frontend")).toEqual({ kind: "branch", baseRef: null });
  });

  it("keeps a selection that is still configured", () => {
    useDiffPanelStore.getState().selectRepository(THREAD_REF, NESTED_REPOSITORY);

    expect(repositoryFor(THREAD_REF, [{ path: NESTED_REPOSITORY }])).toBe(NESTED_REPOSITORY);
    // An empty list means the configuration has not loaded yet; the stale entry
    // stays in the store so the choice returns once t3.json arrives.
    expect(repositoryFor(THREAD_REF, [])).toBe(null);
    expect(useDiffPanelStore.getState().selectedRepositoryByThreadKey).toEqual({
      [scopedThreadKey(THREAD_REF)]: NESTED_REPOSITORY,
    });
  });

  it("drops the repository selection when a turn is selected", () => {
    const turnId = TurnId.make("turn-1");
    useDiffPanelStore.getState().selectRepository(THREAD_REF, NESTED_REPOSITORY);
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId);

    expect(repositoryFor(THREAD_REF)).toBe(null);
    expect(selectionFor(THREAD_REF, null)).toEqual({
      kind: "turn",
      turnId,
      filePath: null,
      revealRequestId: 1,
    });
  });

  it("keeps a bare turn visible while the panel resolves the configured default path", () => {
    const turnId = TurnId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId);

    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({
      kind: "turn",
      turnId,
      filePath: null,
      revealRequestId: 1,
    });
  });

  it("switches back from a turn when a repository is selected, including the default", () => {
    const turnId = TurnId.make("turn-1");
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/root", null);
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId);
    useDiffPanelStore.getState().selectRepository(THREAD_REF, NESTED_REPOSITORY);

    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({
      kind: "branch",
      baseRef: null,
    });

    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId);
    useDiffPanelStore.getState().selectRepository(THREAD_REF, null);
    expect(selectionFor(THREAD_REF, null)).toEqual({ kind: "branch", baseRef: "origin/root" });
  });

  it("restores the root base when leaving a turn through a nested scope and workspace root", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/root", null);
    store.selectTurn(THREAD_REF, TurnId.make("turn-1"));
    store.selectGitScope(THREAD_REF, "unstaged", NESTED_REPOSITORY);
    store.selectRepository(THREAD_REF, ".");

    expect(repositoryFor(THREAD_REF, NESTED_FIRST_REPOSITORIES)).toBe(null);
    expect(selectionFor(THREAD_REF, null)).toEqual({ kind: "branch", baseRef: "origin/root" });
  });

  it("removes every repository entry of a thread without touching similar thread keys", () => {
    const store = useDiffPanelStore.getState();
    store.selectBranchBaseRef(THREAD_REF, "origin/main", null);
    store.selectBranchBaseRef(THREAD_REF, "origin/api", NESTED_REPOSITORY);
    store.selectRepository(THREAD_REF, NESTED_REPOSITORY);
    store.selectBranchBaseRef(SIMILAR_THREAD_REF, "origin/other", null);
    store.selectBranchBaseRef(SIMILAR_THREAD_REF, "origin/other-api", NESTED_REPOSITORY);
    store.selectRepository(SIMILAR_THREAD_REF, NESTED_REPOSITORY);

    useDiffPanelStore.getState().removeThread(THREAD_REF);

    expect(selectionFor(THREAD_REF, null)).toEqual({ kind: "branch", baseRef: null });
    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({ kind: "branch", baseRef: null });
    expect(repositoryFor(THREAD_REF)).toBe(null);
    // A dropped base ref must not resurface when the scope is picked again.
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch", NESTED_REPOSITORY);
    expect(selectionFor(THREAD_REF, NESTED_REPOSITORY)).toEqual({ kind: "branch", baseRef: null });

    expect(selectionFor(SIMILAR_THREAD_REF, null)).toEqual({
      kind: "branch",
      baseRef: "origin/other",
    });
    expect(selectionFor(SIMILAR_THREAD_REF, NESTED_REPOSITORY)).toEqual({
      kind: "branch",
      baseRef: "origin/other-api",
    });
    expect(repositoryFor(SIMILAR_THREAD_REF)).toBe(NESTED_REPOSITORY);
  });
});
