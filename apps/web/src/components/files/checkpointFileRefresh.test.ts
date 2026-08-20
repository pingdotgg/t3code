import { CheckpointRef, type OrchestrationCheckpointSummary, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type CheckpointsSnapshot,
  buildSnapshot,
  checkpointFilesIncludePath,
  evaluateScopeRefresh,
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
    // Scope inactive across turns 3 (touches the file) and 4 (does not);
    // reconciling against only the newest checkpoint would miss turn 3.
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
    // An interrupted turn leaves a placeholder at count 3; the marker saw it
    // via maxTurnCount. Reverting it away keeps the newest captured
    // checkpoint identical, so only the count drop signals the revert.
    const result = evaluateScopeRefresh(
      { completedAt: "T2", maxTurnCount: 3 },
      snapshot(2, [{ completedAt: "T2", files: [file("src/main.tsx")] }]),
      touchesOpenFile,
    );
    expect(result.action).toBe("refresh");
  });

  it("refreshes when a revert-then-redo recreated checkpoints under old turn counts", () => {
    // While the scope was inactive: revert from turn 3 to 1, then two new
    // turns recreate counts 2 and 3. Counts and ref names match the marker's
    // era; only the capture times reveal the new work.
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
    // An interrupted turn is captured with status "missing" but a genuine
    // changed-file list; dropping it would hide the turn's partial edits.
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
