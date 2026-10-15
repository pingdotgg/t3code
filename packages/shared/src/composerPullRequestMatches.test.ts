import { describe, expect, it } from "vite-plus/test";

import type { ThreadPullRequestLink } from "@t3tools/contracts";

import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
} from "./composerPullRequestMatches.ts";

const entry = (number: number, updatedAt: string) => ({
  number,
  projectId: "p1",
  repository: "owner/repo",
  updatedAt,
});

describe("filterComposerPullRequestMatches", () => {
  it("ranks the exact number above newer substring matches", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(1234, "2026-01-03"), entry(123, "2026-01-01"), entry(1230, "2026-01-02")],
      projectId: "p1",
      repository: "owner/repo",
      query: "123",
      limit: 10,
    });
    expect(result.map((match) => match.number)).toEqual([123, 1234, 1230]);
  });

  it("leaves the caller's array untouched", () => {
    // The sort runs on a copy; mutating the input would reorder whatever the caller holds.
    const entries = [entry(2, "2026-01-01"), entry(1, "2026-01-02")];
    const snapshot = entries.map((match) => match.number);
    filterComposerPullRequestMatches({
      entries,
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 10,
    });
    expect(entries.map((match) => match.number)).toEqual(snapshot);
  });

  it("de-duplicates and honours the limit", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(7, "2026-01-02"), entry(7, "2026-01-01"), entry(8, "2026-01-03")],
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 1,
    });
    expect(result).toHaveLength(1);
  });
});

describe("linked pull requests", () => {
  const link = (
    repository: string,
    number: number,
    overrides: Partial<ThreadPullRequestLink> = {},
  ): ThreadPullRequestLink => ({
    host: "github.com",
    repository,
    number,
    url: `https://github.com/${repository}/pull/${number}`,
    source: "agent",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state: "open",
      title: `${repository} ${number}`,
      headBranch: "feature",
      baseBranch: "main",
      isDraft: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
      syncedAt: "2026-01-02T00:00:00.000Z",
    },
    stack: null,
    ...overrides,
  });

  it("offers a linked pull request from another repository above the project's own", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(4, "2026-01-03"), { ...entry(4, "2026-01-04"), repository: "owner/other" }],
      linked: composerPullRequestsFromLinks([link("owner/repo-b", 4)], "p1"),
      projectId: "p1",
      repository: "owner/repo",
      query: "4",
      limit: 10,
    });
    expect(result.map((match) => `${match.repository}#${match.number}`)).toEqual([
      "owner/repo-b#4",
      "owner/repo#4",
    ]);
  });

  it("keeps one row for a linked pull request the project listing already has", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(4, "2026-01-03")],
      linked: composerPullRequestsFromLinks([link("Owner/Repo", 4)], "p1"),
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 10,
    });
    expect(result).toEqual([entry(4, "2026-01-03")]);
  });

  it("skips links that are not synced yet or were dismissed", () => {
    expect(
      composerPullRequestsFromLinks(
        [
          link("owner/repo-b", 4, { snapshot: null }),
          link("owner/repo-b", 5, { source: "stack-dismissed" }),
        ],
        "p1",
      ),
    ).toEqual([]);
  });
});
