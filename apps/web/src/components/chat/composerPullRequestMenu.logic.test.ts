import {
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetail,
  type PullRequestListEntry,
  type PullRequestListResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildComposerPullRequestItems,
  resolveComposerPullRequestEmptyStateKind,
} from "./composerPullRequestMenu.logic";

const PROJECT_ID = ProjectId.make("project-1");
const GITHUB = SourceControlProviderKind.make("github");

const provider = (projectCount: number): PullRequestListResult["providers"][number] => ({
  host: "github.com",
  kind: GITHUB,
  searchesOnHost: true,
  projectCount,
  configured: true,
  detail: null,
});

const listEntry = (
  repository: string,
  number: number,
  overrides: Partial<PullRequestListEntry> = {},
): PullRequestListEntry => ({
  provider: GITHUB,
  host: "github.com",
  projectId: PROJECT_ID,
  projectTitle: "Workspace",
  repository,
  number,
  title: `${repository} PR ${number}`,
  url: `https://github.com/${repository}/pull/${number}`,
  author: null,
  headBranch: `feat/${number}`,
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 0,
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-02T00:00:00Z",
  viewerReviewRequested: false,
  labels: [],
  ...overrides,
});

const detailEntry = (repository: string, number: number): PullRequestDetail => ({
  provider: GITHUB,
  capabilities: {
    diff: true,
    comment: true,
    actions: [],
    mergeMethods: [],
    search: true,
    review: { inlineComment: true, reply: true, resolve: true, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
  },
  projectId: PROJECT_ID,
  projectTitle: "Workspace",
  workspaceRoot: `/workspace/${repository}`,
  repository,
  number,
  title: `Older ${repository} PR ${number}`,
  body: "",
  url: `https://github.com/${repository}/pull/${number}`,
  author: null,
  state: "closed",
  isDraft: false,
  mergeability: "unknown",
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  headBranch: `old/${number}`,
  baseBranch: "main",
  createdAt: "2025-01-01T00:00:00Z",
  updatedAt: "2025-01-02T00:00:00Z",
  mergedAt: null,
  closedAt: "2025-01-02T00:00:00Z",
  reviewers: [],
  labels: [],
  checks: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
});

describe("composer pull request menu", () => {
  it("lists and distinguishes pull requests across multiple tracked repositories", () => {
    const numericItems = buildComposerPullRequestItems({
      projectId: PROJECT_ID,
      repository: null,
      hasTrackedFolders: true,
      query: "25",
      triggerNumber: 25,
      listedEntries: [
        listEntry("acme/repo-a", 25, {
          title: "API fix",
          updatedAt: "2026-07-05T00:00:00Z",
        }),
      ],
      providers: [provider(2)],
      exactDetails: [detailEntry("acme/repo-b", 25)],
      linkedPullRequests: [],
      limit: 12,
    });
    expect(numericItems.map((item) => [item.label, item.description])).toEqual([
      ["#25", "acme/repo-a · API fix"],
      ["#25", "acme/repo-b · Older acme/repo-b PR 25"],
    ]);

    const textItems = buildComposerPullRequestItems({
      projectId: PROJECT_ID,
      repository: null,
      hasTrackedFolders: true,
      query: "login",
      triggerNumber: null,
      listedEntries: [
        listEntry("acme/repo-a", 12, {
          title: "Fix login flow",
          updatedAt: "2026-07-04T00:00:00Z",
        }),
        listEntry("acme/repo-b", 18, {
          title: "Add login telemetry",
          updatedAt: "2026-07-05T00:00:00Z",
        }),
      ],
      providers: [provider(2)],
      exactDetails: [],
      linkedPullRequests: [],
      limit: 12,
    });
    expect(textItems.map((item) => item.description)).toEqual([
      "acme/repo-b · Add login telemetry",
      "acme/repo-a · Fix login flow",
    ]);
  });

  it("distinguishes unavailable projects from empty tracked repositories", () => {
    expect(
      resolveComposerPullRequestEmptyStateKind({
        projectId: PROJECT_ID,
        repository: null,
        hasTrackedFolders: false,
        query: "25",
        listData: null,
        listError: null,
      }),
    ).toBe("unavailable");

    expect(
      resolveComposerPullRequestEmptyStateKind({
        projectId: PROJECT_ID,
        repository: null,
        hasTrackedFolders: true,
        query: "25",
        listData: { providers: [], entries: [], errors: [] },
        listError: null,
      }),
    ).toBe("unavailable");

    expect(
      resolveComposerPullRequestEmptyStateKind({
        projectId: PROJECT_ID,
        repository: null,
        hasTrackedFolders: true,
        query: "25",
        listData: { providers: [provider(2)], entries: [], errors: [] },
        listError: null,
      }),
    ).toBe("no-match");

    expect(
      resolveComposerPullRequestEmptyStateKind({
        projectId: PROJECT_ID,
        repository: null,
        hasTrackedFolders: true,
        query: "",
        listData: { providers: [provider(1)], entries: [], errors: [] },
        listError: null,
      }),
    ).toBe("empty");
  });

  it("surfaces exact-lookup detail errors instead of no-match while keeping not-found as no-match", () => {
    expect(
      resolveComposerPullRequestEmptyStateKind({
        projectId: PROJECT_ID,
        repository: "acme/api",
        hasTrackedFolders: false,
        query: "25",
        listData: { providers: [provider(1)], entries: [], errors: [] },
        listError: null,
        detailError: { environmentId: "env-1", message: "This host has no working credentials." },
      }),
    ).toBe("error");

    expect(
      resolveComposerPullRequestEmptyStateKind({
        projectId: PROJECT_ID,
        repository: "acme/api",
        hasTrackedFolders: false,
        query: "25",
        listData: { providers: [provider(1)], entries: [], errors: [] },
        listError: null,
        detailError: null,
      }),
    ).toBe("no-match");
  });
});
