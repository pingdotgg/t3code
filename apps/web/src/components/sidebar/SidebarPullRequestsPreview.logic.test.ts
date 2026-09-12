import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  collectPullRequestPreviewEntries,
  type PullRequestPreviewThread,
} from "./SidebarPullRequestsPreview.logic";

const NOW = "2026-09-08T12:00:00.000Z";
const env = "env-1" as EnvironmentId;

function thread(
  id: string,
  overrides: Partial<PullRequestPreviewThread> = {},
): PullRequestPreviewThread {
  return {
    id: id as PullRequestPreviewThread["id"],
    environmentId: env,
    title: `Thread ${id}`,
    branch: null,
    archivedAt: null,
    settledOverride: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    snoozedUntil: null,
    snoozedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    session: null,
    latestTurn: null,
    ...overrides,
  };
}

function pr(number: number) {
  return {
    projectId: "project-1" as ProjectId,
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
  };
}

const capabilities = new Map([[env, { threadSettlement: true, threadSnooze: true }]]);

describe("collectPullRequestPreviewEntries", () => {
  it("keeps only unarchived, unsettled threads that have a pull request", () => {
    const entries = collectPullRequestPreviewEntries(
      [
        thread("a", { linkedPullRequest: pr(1) }),
        thread("b"),
        thread("c", { linkedPullRequest: pr(2), archivedAt: NOW }),
        thread("d", { linkedPullRequest: pr(3), settledOverride: "settled" }),
        thread("e", { branchPullRequest: pr(4) }),
      ],
      capabilities,
      NOW,
    );
    expect(entries.map((entry) => entry.reference.number)).toEqual([1, 4]);
    expect(entries.every((entry) => !entry.snoozed)).toBe(true);
  });

  it("prefers the linked pull request over the branch match", () => {
    const [entry] = collectPullRequestPreviewEntries(
      [thread("a", { linkedPullRequest: pr(7), branchPullRequest: pr(8) })],
      capabilities,
      NOW,
    );
    expect(entry?.reference.number).toBe(7);
  });

  it("lists active threads first, then snoozed threads by wake time", () => {
    const entries = collectPullRequestPreviewEntries(
      [
        thread("late", { linkedPullRequest: pr(1), snoozedUntil: "2026-09-09T12:00:00.000Z" }),
        thread("soon", { linkedPullRequest: pr(2), snoozedUntil: "2026-09-08T13:00:00.000Z" }),
        thread("active", { linkedPullRequest: pr(3) }),
        thread("woken", { linkedPullRequest: pr(4), snoozedUntil: "2026-09-08T11:00:00.000Z" }),
      ],
      capabilities,
      NOW,
    );
    expect(entries.map((entry) => [entry.reference.number, entry.snoozed])).toEqual([
      [3, false],
      [4, false],
      [2, true],
      [1, true],
    ]);
  });

  it("treats settled threads as active on servers without settlement", () => {
    const entries = collectPullRequestPreviewEntries(
      [thread("a", { linkedPullRequest: pr(1), settledOverride: "settled" })],
      new Map([[env, { threadSettlement: false, threadSnooze: false }]]),
      NOW,
    );
    expect(entries).toHaveLength(1);
  });

  it("counts a pull request as active when an active thread shares it with a snoozed one", () => {
    const entries = collectPullRequestPreviewEntries(
      [
        thread("napping", { linkedPullRequest: pr(1), snoozedUntil: "2026-09-09T12:00:00.000Z" }),
        thread("awake", { branchPullRequest: pr(1) }),
      ],
      capabilities,
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.thread.id).toBe("awake");
    expect(entries[0]?.snoozed).toBe(false);
  });

  it("shows a pull request once when several threads share it", () => {
    const entries = collectPullRequestPreviewEntries(
      [
        thread("a", { linkedPullRequest: pr(1) }),
        thread("b", { branchPullRequest: { ...pr(1), repository: "T3Tools/T3Code" } }),
      ],
      capabilities,
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.thread.id).toBe("a");
  });
});
