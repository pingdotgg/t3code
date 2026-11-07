import { describe, expect, it } from "vite-plus/test";

import type { ThreadPullRequestLink } from "@t3tools/contracts";

import {
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
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

  it("puts linked pull requests ahead of a text search, before and after it returns", () => {
    const linked = composerPullRequestsFromLinks(
      [
        link("owner/repo", 7, {
          snapshot: { ...link("owner/repo", 7).snapshot!, title: "Fix login" },
        }),
        link("owner/repo", 8),
      ],
      "p1",
    );
    const searching = withLinkedComposerPullRequestsFirst({
      matches: [],
      linked,
      query: "fix",
      limit: 10,
    });
    expect(searching.map((match) => match.number)).toEqual([7]);
    const searched = withLinkedComposerPullRequestsFirst({
      matches: [entry(9, "2026-01-05"), entry(8, "2026-01-03")],
      linked,
      query: "fix",
      limit: 10,
    });
    expect(searched).toEqual([linked[0], entry(8, "2026-01-03"), entry(9, "2026-01-05")]);
  });
});
