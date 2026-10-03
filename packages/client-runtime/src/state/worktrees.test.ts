import { ProjectId, type WorktreeInfo } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  confirmWorktreeRemoval,
  formatWorktreeAge,
  groupWorktreesByProject,
  NO_CONFIRMED_WORKTREE_REMOVALS,
  visibleWorktrees,
  worktreeBranchLabel,
  worktreeGroupSummary,
  worktreeIgnoredNote,
  worktreeInventoryRefreshKey,
  worktreeRemovalConfirmation,
  worktreeRemovalOutcome,
  worktreeStateLabel,
} from "./worktrees.ts";

const projectId = ProjectId.make("project-1");

function worktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    projectId,
    projectTitle: "t3code",
    workspaceRoot: "/repo",
    projects: [{ projectId, projectTitle: "t3code", workspaceRoot: "/repo" }],
    path: "/worktrees/feature",
    branch: "feature",
    headShortSha: "a7d01ef",
    threads: [],
    dirty: false,
    dirtyFileCount: 0,
    ignoredFileCount: 0,
    ignoredFiles: [],
    hasUpstream: true,
    upstreamGone: false,
    aheadOfUpstreamCount: 0,
    behindUpstreamCount: 0,
    aheadOfDefaultCount: null,
    lastActivityAt: null,
    safeToPrune: true,
    pruneBlockers: [],
    ...overrides,
  };
}

const blocked = (overrides: Partial<WorktreeInfo>) =>
  worktree({ safeToPrune: false, ...overrides });

describe("worktree inventory refresh", () => {
  const decide = (
    listedRevision: number | undefined,
    streamRevision: number | undefined,
    options: { readonly isPending?: boolean; readonly lastRefreshKey?: string | null } = {},
  ) =>
    worktreeInventoryRefreshKey({
      listedRevision,
      streamRevision,
      isPending: options.isPending ?? false,
      lastRefreshKey: options.lastRefreshKey ?? null,
    });

  it("reads again when a change landed between the list and the subscription", () => {
    expect(decide(4, 5)).toBe("4:5");
    expect(decide(5, 5)).toBeNull();
  });

  it("waits for a read in flight, then compares its revision", () => {
    expect(decide(4, 5, { isPending: true })).toBeNull();
    // The read started before the change and came back with the old revision.
    expect(decide(4, 6, { lastRefreshKey: "3:5" })).toBe("4:6");
  });

  it("reads again after a server restart, whose revisions start elsewhere", () => {
    expect(decide(1_700_000_000_005, 1_700_000_900_000)).not.toBeNull();
  });

  it("does not loop on a read that failed and left the list unchanged", () => {
    expect(decide(4, 5, { lastRefreshKey: "4:5" })).toBeNull();
  });

  it("waits until both the list and the stream have reported", () => {
    expect(decide(undefined, 5)).toBeNull();
    expect(decide(4, undefined)).toBeNull();
  });
});

describe("worktree rows", () => {
  it("drops a confirmed removal at once and keeps every other row", () => {
    const kept = worktree({ path: "/worktrees/kept" });
    const removed = worktree({ path: "/worktrees/removed" });
    const inventory = { worktrees: [kept, removed], revision: 4 };
    const removals = confirmWorktreeRemoval(NO_CONFIRMED_WORKTREE_REMOVALS, 4, removed.path);

    expect(visibleWorktrees(inventory, NO_CONFIRMED_WORKTREE_REMOVALS)).toEqual([kept, removed]);
    expect(visibleWorktrees(inventory, removals)).toEqual([kept]);
    expect(visibleWorktrees(null, removals)).toEqual([]);
  });

  it("shows a worktree revived at a removed path once the list is read again", () => {
    const revived = worktree({ path: "/worktrees/removed" });
    const removals = confirmWorktreeRemoval(NO_CONFIRMED_WORKTREE_REMOVALS, 4, revived.path);

    expect(visibleWorktrees({ worktrees: [revived], revision: 6 }, removals)).toEqual([revived]);
  });

  it("groups by project with removable worktrees first", () => {
    const other = ProjectId.make("project-2");
    const groups = groupWorktreesByProject([
      blocked({ path: "/worktrees/a", pruneBlockers: ["dirty"] }),
      worktree({ path: "/worktrees/b" }),
      worktree({ path: "/worktrees/c", projectId: other, projectTitle: "docs-site" }),
    ]);

    expect(groups.map((group) => group.projectTitle)).toEqual(["docs-site", "t3code"]);
    expect(groups[1]?.worktrees.map((entry) => entry.path)).toEqual([
      "/worktrees/b",
      "/worktrees/a",
    ]);
    expect(worktreeGroupSummary(groups[1]!)).toBe("2, 1 removable");
  });

  it("tells detached checkouts apart by commit", () => {
    expect(worktreeBranchLabel(worktree({ branch: null }))).toBe("Detached HEAD a7d01ef");
    expect(worktreeBranchLabel(worktree())).toBe("feature");
  });

  it("formats age without a suffix", () => {
    const now = Date.parse("2026-06-10T12:00:00.000Z");
    expect(formatWorktreeAge("2026-06-10T11:59:40.000Z", now)).toBe("now");
    expect(formatWorktreeAge("2026-06-10T11:20:00.000Z", now)).toBe("40m");
    expect(formatWorktreeAge("2026-06-07T12:00:00.000Z", now)).toBe("3d");
  });
});

describe("worktree state label", () => {
  it("has none for a removable worktree", () => {
    expect(worktreeStateLabel(worktree())).toBeNull();
  });

  it("separates a checkout in use from an idle open thread", () => {
    expect(
      worktreeStateLabel(blocked({ pruneBlockers: ["running", "open_thread"] })),
    ).toMatchObject({ text: "In use", tone: "neutral" });
    expect(worktreeStateLabel(blocked({ pruneBlockers: ["terminal"] }))?.text).toBe("In use");
    expect(worktreeStateLabel(blocked({ pruneBlockers: ["open_thread"] }))).toMatchObject({
      text: "Open thread",
      tone: "neutral",
    });
  });

  it("counts changed files and unpushed commits separately", () => {
    expect(
      worktreeStateLabel(
        blocked({
          pruneBlockers: ["dirty", "unpushed", "open_thread"],
          dirtyFileCount: 4,
          aheadOfUpstreamCount: 2,
        }),
      ),
    ).toMatchObject({ text: "4 changed, 2 unpushed", tone: "warning" });
  });

  it("calls commits unmerged without an upstream or on a detached checkout", () => {
    expect(
      worktreeStateLabel(
        blocked({
          pruneBlockers: ["unpushed"],
          hasUpstream: false,
          aheadOfUpstreamCount: null,
          aheadOfDefaultCount: 5,
        }),
      )?.text,
    ).toBe("5 unmerged");
    expect(
      worktreeStateLabel(
        blocked({
          branch: null,
          pruneBlockers: ["unpushed", "unrestorable_thread"],
          aheadOfUpstreamCount: null,
          aheadOfDefaultCount: 3,
        }),
      )?.text,
    ).toBe("3 unmerged, Linked thread");
  });

  it("reports unreadable status", () => {
    expect(worktreeStateLabel(blocked({ pruneBlockers: ["status_unavailable"] }))).toMatchObject({
      text: "Status unknown",
      tone: "warning",
    });
  });
});

describe("worktree removal", () => {
  it("opts in to deleting ignored files only when the confirmation lists them", () => {
    expect(worktreeRemovalConfirmation(worktree())).toMatchObject({
      title: "Remove feature?",
      message: "The branch and checkpoints stay.",
      allowIgnoredFiles: false,
    });

    const withIgnored = worktree({ ignoredFileCount: 7, ignoredFiles: [".env", "dist/"] });
    expect(worktreeIgnoredNote(withIgnored)).toBe("7 ignored");
    expect(worktreeRemovalConfirmation(withIgnored)).toEqual({
      title: "Remove feature?",
      message: "The branch and checkpoints stay. These ignored files are deleted:",
      ignoredFiles: [".env", "dist/"],
      ignoredMoreCount: 5,
      allowIgnoredFiles: true,
    });
  });

  it("explains why the server kept a worktree", () => {
    expect(
      worktreeRemovalOutcome({
        removed: [],
        skipped: [{ path: "/worktrees/feature", reason: "session" }],
      }),
    ).toEqual({ removed: false, message: "A provider session is still using it." });
    expect(
      worktreeRemovalOutcome({
        removed: [{ path: "/worktrees/feature", workspaceRoot: "/repo" }],
        skipped: [],
      }),
    ).toEqual({ removed: true });
  });
});
