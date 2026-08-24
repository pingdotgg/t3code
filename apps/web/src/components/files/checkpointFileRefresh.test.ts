import { CheckpointRef, type OrchestrationCheckpointSummary, TurnId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  MAX_RECONCILED_SCOPES,
  type CheckpointsSnapshot,
  type ScopeReconciliationState,
  buildSnapshot,
  checkpointFilesIncludePath,
  checkpointRefreshQueryAtom,
  createScopeReconciliationCache,
  evaluateScopeRefresh,
  reconcileScopeRefresh,
} from "./checkpointFileRefresh";

function file(path: string) {
  return { path, kind: "modified", additions: 1, deletions: 0 };
}

function snapshot(
  maxTurnCount: number,
  checkpoints: ReadonlyArray<{
    completedAt: string;
    files: ReadonlyArray<ReturnType<typeof file>>;
  }>,
): CheckpointsSnapshot {
  return {
    maxTurnCount,
    latestCompletedAt: checkpoints.reduce(
      (latest, entry) => (entry.completedAt > latest ? entry.completedAt : latest),
      "",
    ),
    checkpoints,
  };
}

const touchesOpenFile = (files: ReadonlyArray<ReturnType<typeof file>>) =>
  checkpointFilesIncludePath(files, "src/main.tsx");

function emptyReconciliationState(): ScopeReconciliationState {
  return {
    marker: undefined,
    reconciledSnapshot: undefined,
    initialFetchSnapshot: undefined,
  };
}

describe("checkpointRefreshQueryAtom", () => {
  it("does not subscribe to a query while its scope is disabled", () => {
    const subscribed = vi.fn();
    const queryAtom = Atom.make(() => {
      subscribed();
      return AsyncResult.initial<string, never>(false);
    });
    const registry = AtomRegistry.make();

    const unmountInactive = registry.mount(checkpointRefreshQueryAtom(null, queryAtom));
    expect(subscribed).not.toHaveBeenCalled();

    const unmountActive = registry.mount(checkpointRefreshQueryAtom("file:scope", queryAtom));
    expect(subscribed).toHaveBeenCalledOnce();

    unmountActive();
    unmountInactive();
    registry.dispose();
  });
});

describe("evaluateScopeRefresh", () => {
  it("asks to refresh on first observation, since prior freshness is unprovable", () => {
    const result = evaluateScopeRefresh(
      undefined,
      snapshot(2, [{ completedAt: "T2", files: [file("src/main.tsx")] }]),
      touchesOpenFile,
    );
    expect(result.action).toBe("refresh");
    expect(result.marker).toEqual({ completedAt: "T2", maxTurnCount: 2 });
  });

  it("does nothing while checkpoints are unchanged", () => {
    const result = evaluateScopeRefresh(
      { completedAt: "T2", maxTurnCount: 2 },
      snapshot(2, [{ completedAt: "T2", files: [file("src/main.tsx")] }]),
      touchesOpenFile,
    );
    expect(result.action).toBe("none");
  });

  it("refreshes when a newer checkpoint touched the scope", () => {
    const result = evaluateScopeRefresh(
      { completedAt: "T2", maxTurnCount: 2 },
      snapshot(3, [{ completedAt: "T3", files: [file("src/main.tsx")] }]),
      touchesOpenFile,
    );
    expect(result.action).toBe("refresh");
  });

  it("advances the marker without refreshing when newer checkpoints are irrelevant", () => {
    const result = evaluateScopeRefresh(
      { completedAt: "T2", maxTurnCount: 2 },
      snapshot(3, [{ completedAt: "T3", files: [file("docs/other.md")] }]),
      touchesOpenFile,
    );
    expect(result.action).toBe("none");
    expect(result.marker).toEqual({ completedAt: "T3", maxTurnCount: 3 });
  });

  it("catches a relevant turn buried under later irrelevant turns", () => {
    const result = evaluateScopeRefresh(
      { completedAt: "T2", maxTurnCount: 2 },
      snapshot(4, [
        { completedAt: "T2", files: [file("src/main.tsx")] },
        { completedAt: "T3", files: [file("src/main.tsx")] },
        { completedAt: "T4", files: [file("docs/other.md")] },
      ]),
      touchesOpenFile,
    );
    expect(result.action).toBe("refresh");
  });

  it("refreshes on a revert, detected as a max turn count drop", () => {
    const result = evaluateScopeRefresh(
      { completedAt: "T2", maxTurnCount: 2 },
      snapshot(1, [{ completedAt: "T1", files: [] }]),
      touchesOpenFile,
    );
    expect(result.action).toBe("refresh");
  });

  it("refreshes when reverting away only a mid-turn placeholder", () => {
    const result = evaluateScopeRefresh(
      { completedAt: "T2", maxTurnCount: 3 },
      snapshot(2, [{ completedAt: "T2", files: [file("src/main.tsx")] }]),
      touchesOpenFile,
    );
    expect(result.action).toBe("refresh");
  });

  it("refreshes when a revert-then-redo recreated checkpoints under old turn counts", () => {
    const result = evaluateScopeRefresh(
      { completedAt: "T3", maxTurnCount: 3 },
      snapshot(3, [
        { completedAt: "T1", files: [] },
        { completedAt: "T4", files: [file("src/main.tsx")] },
        { completedAt: "T5", files: [file("docs/other.md")] },
      ]),
      touchesOpenFile,
    );
    expect(result.action).toBe("refresh");
  });
});

describe("reconcileScopeRefresh", () => {
  it("refreshes a checkpoint that appears while the initial query is waiting", () => {
    const firstCheckpoint = snapshot(1, [{ completedAt: "T1", files: [file("src/main.tsx")] }]);
    const latestCheckpoint = snapshot(2, [
      { completedAt: "T1", files: [file("src/main.tsx")] },
      { completedAt: "T2", files: [file("src/main.tsx")] },
    ]);

    let result = reconcileScopeRefresh(undefined, null, true, touchesOpenFile);
    result = reconcileScopeRefresh(result.state, firstCheckpoint, true, touchesOpenFile);
    expect(result.action).toBe("none");
    expect(result.state.marker).toBeUndefined();

    result = reconcileScopeRefresh(result.state, latestCheckpoint, true, touchesOpenFile);
    expect(result.action).toBe("none");
    expect(result.state.marker).toBeUndefined();

    result = reconcileScopeRefresh(result.state, latestCheckpoint, false, touchesOpenFile);
    expect(result.action).toBe("refresh");
    expect(result.state.marker).toEqual({ completedAt: "T2", maxTurnCount: 2 });

    result = reconcileScopeRefresh(result.state, latestCheckpoint, false, touchesOpenFile);
    expect(result.action).toBe("none");
  });

  it("does not refetch when the initial query started with the snapshot it read", () => {
    const existingCheckpoint = snapshot(1, [{ completedAt: "T1", files: [file("src/main.tsx")] }]);

    let result = reconcileScopeRefresh(undefined, existingCheckpoint, true, touchesOpenFile);
    expect(result.action).toBe("none");
    expect(result.state.marker).toEqual({ completedAt: "T1", maxTurnCount: 1 });

    result = reconcileScopeRefresh(result.state, existingCheckpoint, false, touchesOpenFile);
    expect(result.action).toBe("none");
  });

  it("refreshes once when a reverted scope settles with no checkpoints", () => {
    const existingCheckpoint = snapshot(1, [{ completedAt: "T1", files: [file("src/main.tsx")] }]);

    let result = reconcileScopeRefresh(undefined, existingCheckpoint, false, touchesOpenFile);
    expect(result.state.marker).toBeDefined();

    result = reconcileScopeRefresh(result.state, null, true, touchesOpenFile);
    expect(result.action).toBe("none");
    expect(result.state.marker).toBeDefined();

    result = reconcileScopeRefresh(result.state, null, false, touchesOpenFile);
    expect(result.action).toBe("refresh");
    expect(result.state).toEqual(emptyReconciliationState());

    result = reconcileScopeRefresh(result.state, null, true, touchesOpenFile);
    expect(result.action).toBe("none");
    result = reconcileScopeRefresh(result.state, null, false, touchesOpenFile);
    expect(result.action).toBe("none");
  });

  it("refreshes when a placeholder gains files without advancing its cursor", () => {
    const placeholder = snapshot(1, [{ completedAt: "T1", files: [] }]);
    const captured = snapshot(1, [{ completedAt: "T1", files: [file("src/main.tsx")] }]);

    let result = reconcileScopeRefresh(undefined, placeholder, true, touchesOpenFile);
    result = reconcileScopeRefresh(result.state, placeholder, false, touchesOpenFile);
    expect(result.action).toBe("none");

    result = reconcileScopeRefresh(result.state, captured, false, touchesOpenFile);
    expect(result.action).toBe("refresh");
  });

  it("bounds retained scope state and safely refreshes an evicted scope", () => {
    const cache = createScopeReconciliationCache();
    const state = emptyReconciliationState();
    cache.set("evicted", state);
    for (let index = 0; index < MAX_RECONCILED_SCOPES; index += 1) {
      cache.set(`scope-${index}`, state);
    }

    expect(cache.size()).toBe(MAX_RECONCILED_SCOPES);
    expect(cache.get("evicted")).toBeUndefined();

    const result = reconcileScopeRefresh(
      cache.get("evicted"),
      snapshot(1, [{ completedAt: "T1", files: [file("src/main.tsx")] }]),
      false,
      touchesOpenFile,
    );
    expect(result.action).toBe("refresh");

    let emptyResult = reconcileScopeRefresh(cache.get("evicted"), null, false, touchesOpenFile);
    expect(emptyResult.action).toBe("refresh");
    cache.set("evicted", emptyResult.state);

    emptyResult = reconcileScopeRefresh(cache.get("evicted"), null, false, touchesOpenFile);
    expect(emptyResult.action).toBe("none");
  });
});

describe("buildSnapshot", () => {
  function checkpoint(
    turnCount: number,
    status: OrchestrationCheckpointSummary["status"],
    completedAt: string,
    files: OrchestrationCheckpointSummary["files"],
  ): OrchestrationCheckpointSummary {
    return {
      turnId: TurnId.make(`turn-${turnCount}`),
      checkpointTurnCount: turnCount,
      checkpointRef: CheckpointRef.make(`ref-${turnCount}`),
      status,
      files,
      assistantMessageId: null,
      completedAt,
    };
  }

  it("returns null for an empty history", () => {
    expect(buildSnapshot([])).toBeNull();
  });

  it("scans interrupted and failed captures, whose file lists are real", () => {
    const result = buildSnapshot([
      checkpoint(1, "ready", "T1", [file("docs/other.md")]),
      checkpoint(2, "missing", "T2", [file("src/main.tsx")]),
      checkpoint(3, "error", "T3", [file("src/broken.ts")]),
    ]);
    expect(result).toEqual({
      maxTurnCount: 3,
      latestCompletedAt: "T3",
      checkpoints: [
        { completedAt: "T1", files: [file("docs/other.md")] },
        { completedAt: "T2", files: [file("src/main.tsx")] },
        { completedAt: "T3", files: [file("src/broken.ts")] },
      ],
    });
  });
});

describe("checkpointFilesIncludePath", () => {
  const files = [
    { path: "apps/web/src/main.tsx", kind: "modified", additions: 1, deletions: 0 },
    { path: "packages/shared/util.ts", kind: "modified", additions: 2, deletions: 2 },
  ];

  it("matches an exact cwd-relative path", () => {
    expect(checkpointFilesIncludePath(files, "apps/web/src/main.tsx")).toBe(true);
  });

  it("matches repo-relative paths by suffix when cwd is below the repo root", () => {
    expect(checkpointFilesIncludePath(files, "src/main.tsx")).toBe(true);
  });

  it("does not match a partial file name without a directory boundary", () => {
    expect(checkpointFilesIncludePath(files, "ain.tsx")).toBe(false);
  });

  it("does not match untouched files", () => {
    expect(checkpointFilesIncludePath(files, "apps/web/src/other.tsx")).toBe(false);
  });
});
