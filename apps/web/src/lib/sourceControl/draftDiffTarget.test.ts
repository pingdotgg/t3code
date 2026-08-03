/**
 * fork: f4 — clicking a changed file on a brand-new thread landed on
 * *"Select a thread to inspect turn diffs."*
 *
 * Two independent halves, both pinned here: the draft route has to yield the
 * SAME thread ref ChatView keyed the selection by, and the empty state has to
 * stop claiming a file-scoped diff needs a thread.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  NO_DRAFT_DIFF_TARGET,
  resolveDraftDiffTarget,
  showsSelectThreadEmptyState,
  type DraftDiffSession,
} from "./draftDiffTarget";

const ENVIRONMENT_ID = "local" as EnvironmentId;
const THREAD_ID = "thr_draft_1" as ThreadId;

function draft(overrides: Partial<DraftDiffSession> = {}): DraftDiffSession {
  return {
    environmentId: ENVIRONMENT_ID,
    threadId: THREAD_ID,
    worktreePath: null,
    ...overrides,
  };
}

describe("resolveDraftDiffTarget", () => {
  it("recovers the reserved thread ref the selection was written under", () => {
    const target = resolveDraftDiffTarget(draft(), { workspaceRoot: "/repo" });
    // ChatView keys by `scopeThreadRef(activeThread.environmentId, activeThread.id)`
    // where the local draft thread's id IS the draft session's reserved
    // threadId — so this must match field for field or the panel reads an
    // empty selection.
    expect(target.threadRef).toEqual({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID });
    expect(target.environmentId).toBe(ENVIRONMENT_ID);
  });

  it("uses the project workspace root as the working copy", () => {
    expect(resolveDraftDiffTarget(draft(), { workspaceRoot: "/repo" }).cwd).toBe("/repo");
  });

  it("prefers the draft's own worktree when it has one", () => {
    // A draft created with `envMode: "worktree"` already owns a checkout, and
    // its changes live there, not in the project root.
    expect(
      resolveDraftDiffTarget(draft({ worktreePath: "/repo/.worktrees/x" }), {
        workspaceRoot: "/repo",
      }).cwd,
    ).toBe("/repo/.worktrees/x");
  });

  it("still resolves the ref while the project is loading", () => {
    // The ref is what routes the selection; a null cwd only delays the fetch.
    const target = resolveDraftDiffTarget(draft(), null);
    expect(target.threadRef).not.toBeNull();
    expect(target.cwd).toBeNull();
  });

  it("resolves nothing for a server thread", () => {
    expect(resolveDraftDiffTarget(null, { workspaceRoot: "/repo" })).toBe(NO_DRAFT_DIFF_TARGET);
  });
});

describe("showsSelectThreadEmptyState", () => {
  it("renders the working-copy diff on a thread with no turns at all", () => {
    // THE regression. `workingCopy.diff` needs an environment and a cwd, never
    // a turn, so a draft must show the file — not the turn-diff empty state.
    expect(showsSelectThreadEmptyState({ hasThread: false, fileScopedDiffActive: true })).toBe(
      false,
    );
  });

  it("keeps the empty state for the turn and branch scopes", () => {
    expect(showsSelectThreadEmptyState({ hasThread: false, fileScopedDiffActive: false })).toBe(
      true,
    );
  });

  it("never shows the empty state once a thread exists", () => {
    expect(showsSelectThreadEmptyState({ hasThread: true, fileScopedDiffActive: false })).toBe(
      false,
    );
    expect(showsSelectThreadEmptyState({ hasThread: true, fileScopedDiffActive: true })).toBe(
      false,
    );
  });
});
