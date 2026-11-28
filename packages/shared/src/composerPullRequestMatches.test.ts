import { describe, expect, it } from "vite-plus/test";

import type { ThreadPullRequestKey, ThreadPullRequestLink } from "@t3tools/contracts";

import {
  composerExactPullRequestRepositories,
  composerPullRequestsFromLinks,
  filterComposerPullRequestMatches,
  withLinkedComposerPullRequestsFirst,
} from "./composerPullRequestMatches.ts";

const keyOf = (entry: ThreadPullRequestKey) =>
  `${entry.host.trim().toLowerCase()}/${entry.repository.trim().toLowerCase()}#${entry.number}`;

const entry = (number: number, updatedAt: string) => ({
  number,
  host: "github.com",
  projectId: "p1",
  repository: "owner/repo",
  updatedAt,
});

describe("filterComposerPullRequestMatches", () => {
  it("ranks the exact number above newer substring matches", () => {
    const result = filterComposerPullRequestMatches({
      keyOf,
      entries: [entry(1234, "2026-01-03"), entry(123, "2026-01-01"), entry(1230, "2026-01-02")],
      projectId: "p1",
      repository: "owner/repo",
      query: "123",
      limit: 10,
    });
    expect(result.map((match) => match.number)).toEqual([123, 1234, 1230]);
  });

  it("orders by update instant when timestamps carry different UTC offsets", () => {
    const result = filterComposerPullRequestMatches({
      keyOf,
      entries: [entry(401, "2026-10-25T02:50:00+02:00"), entry(499, "2026-10-25T02:10:00+01:00")],
      projectId: "p1",
      repository: "owner/repo",
      query: "4",
      limit: 1,
    });
    expect(result.map((match) => match.number)).toEqual([499]);
  });

  it("matches a zero-padded numeric query to its exact pull request ahead of substring matches", () => {
    const result = filterComposerPullRequestMatches({
      keyOf,
      entries: [entry(10042, "2026-01-03"), entry(42, "2026-01-01"), entry(420, "2026-01-04")],
      projectId: "p1",
      repository: "owner/repo",
      query: "0042",
      limit: 10,
    });
    expect(result.map((match) => match.number)).toEqual([42, 10042]);
  });

  it("matches pull requests across all repositories of a project when repository is null", () => {
    const result = filterComposerPullRequestMatches({
      keyOf,
      entries: [
        { ...entry(25, "2026-01-03"), repository: "owner/repo-a" },
        { ...entry(25, "2026-01-04"), repository: "owner/repo-b" },
        { ...entry(250, "2026-01-05"), repository: "owner/repo-a" },
        { ...entry(25, "2026-01-06"), projectId: "p2", repository: "owner/other" },
      ],
      projectId: "p1",
      repository: null,
      query: "25",
      limit: 10,
    });
    expect(result.map((match) => `${match.repository}#${match.number}`)).toEqual([
      "owner/repo-b#25",
      "owner/repo-a#25",
      "owner/repo-a#250",
    ]);
  });
});

describe("composerExactPullRequestRepositories", () => {
  it("keeps single root repository lookup unchanged", () => {
    expect(
      composerExactPullRequestRepositories({
        projectId: "p1",
        repository: "owner/root",
        entries: [entry(10, "2026-01-01")],
        number: 25,
      }),
    ).toEqual([{ repository: "owner/root" }]);
    expect(
      composerExactPullRequestRepositories({
        projectId: "p1",
        repository: "owner/root",
        entries: [{ ...entry(25, "2026-01-01"), repository: "Owner/Root" }],
        number: 25,
      }),
    ).toEqual([]);
  });

  it("looks up missing exact numbers across tracked-folder repositories", () => {
    expect(
      composerExactPullRequestRepositories({
        projectId: "p1",
        repository: null,
        listedRepositories: [{ host: "github.com", repository: "owner/repo-a" }],
        entries: [{ ...entry(10, "2026-01-01"), repository: "owner/repo-a" }],
        number: 25,
      }),
    ).toEqual([{ host: "github.com", repository: "owner/repo-a" }]);

    expect(
      composerExactPullRequestRepositories({
        projectId: "p1",
        repository: null,
        listedRepositories: [
          { host: "github.com", repository: "owner/repo-a" },
          { host: "github.com", repository: "owner/repo-b" },
        ],
        entries: [{ ...entry(25, "2026-01-01"), repository: "owner/repo-a" }],
        number: 25,
      }),
    ).toEqual([{ host: "github.com", repository: "owner/repo-b" }]);

    expect(
      composerExactPullRequestRepositories({
        projectId: "p1",
        repository: null,
        entries: [
          { ...entry(10, "2026-01-01"), repository: "owner/repo-a" },
          { ...entry(11, "2026-01-01"), repository: "owner/repo-b" },
          { ...entry(12, "2026-01-01"), projectId: "p2", repository: "owner/other" },
        ],
        number: 25,
      }),
    ).toEqual([
      { host: "github.com", repository: "owner/repo-a" },
      { host: "github.com", repository: "owner/repo-b" },
    ]);
  });

  it("keeps same-named repositories on different hosts distinct for exact lookup and suppression", () => {
    expect(
      composerExactPullRequestRepositories({
        projectId: "p1",
        repository: null,
        listedRepositories: [
          { host: "github.com", repository: "acme/api" },
          { host: "gitlab.com", repository: "acme/api" },
        ],
        entries: [{ ...entry(25, "2026-01-01"), host: "github.com", repository: "acme/api" }],
        number: 25,
      }),
    ).toEqual([{ host: "gitlab.com", repository: "acme/api" }]);

    expect(
      composerExactPullRequestRepositories({
        projectId: "p1",
        repository: null,
        listedRepositories: [
          { host: "github.com", repository: "acme/api" },
          { host: "gitlab.com", repository: "acme/api" },
        ],
        entries: [],
        number: 25,
      }),
    ).toEqual([
      { host: "github.com", repository: "acme/api" },
      { host: "gitlab.com", repository: "acme/api" },
    ]);
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
      keyOf,
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

  it("matches linked pull requests for zero-padded numeric queries", () => {
    const result = filterComposerPullRequestMatches({
      keyOf,
      entries: [entry(42, "2026-01-03")],
      linked: composerPullRequestsFromLinks([link("owner/repo-b", 42)], "p1"),
      projectId: "p1",
      repository: "owner/repo",
      query: "0042",
      limit: 10,
    });
    expect(result.map((match) => `${match.repository}#${match.number}`)).toEqual([
      "owner/repo-b#42",
      "owner/repo#42",
    ]);
  });

  it("keeps linked reviews with the same repository and number on different hosts", () => {
    const github = link("wireshark/wireshark", 1);
    const gitlab = link("wireshark/wireshark", 1, {
      host: "gitlab.com",
      url: "https://gitlab.com/wireshark/wireshark/-/merge_requests/1",
    });
    const result = filterComposerPullRequestMatches({
      keyOf,
      entries: [],
      linked: composerPullRequestsFromLinks([github, gitlab], "p1"),
      projectId: "p1",
      repository: "wireshark/wireshark",
      query: "1",
      limit: 10,
    });
    expect(result.map((match) => match.url)).toEqual([github.url, gitlab.url]);
  });

  it("keeps one row for a linked pull request the project listing already has", () => {
    const result = filterComposerPullRequestMatches({
      keyOf,
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
        link("owner/repo", 8, {
          host: "gitlab.com",
          url: "https://gitlab.com/owner/repo/-/merge_requests/8",
          snapshot: { ...link("owner/repo", 8).snapshot!, title: "Fix CI" },
        }),
      ],
      "p1",
    );
    const searching = withLinkedComposerPullRequestsFirst({
      keyOf,
      matches: [],
      linked,
      query: "fix",
      limit: 10,
    });
    expect(searching.map((match) => match.number)).toEqual([7, 8]);
    const searched = withLinkedComposerPullRequestsFirst({
      keyOf,
      matches: [entry(9, "2026-01-05"), entry(8, "2026-01-03")],
      linked,
      query: "fix",
      limit: 10,
    });
    expect(searched).toEqual([
      linked[0],
      entry(8, "2026-01-03"),
      linked[2],
      entry(9, "2026-01-05"),
    ]);
  });
});
