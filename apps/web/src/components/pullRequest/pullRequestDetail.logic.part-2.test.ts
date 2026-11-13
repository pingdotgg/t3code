import { SourceControlProviderKind } from "@t3tools/contracts";
import { resolvePlanFollowUpSubmission } from "../../proposedPlan";
import {
  GitCommandError,
  ProjectId,
  type PullRequestCheck,
  type PullRequestComment,
  type PullRequestDetail,
  type PullRequestDetailView,
  type PullRequestRef,
  type PullRequestReviewThread,
  type PullRequestState,
  type RepositoryIdentity,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { buildMessageContext, reviewCommentContextReference } from "~/lib/composerContextRecords";
import {
  buildAddSelectionToAgentHandoff,
  buildExplainPullRequestHandoff,
  buildResolveConflictsPrompt,
  resolveThreadPanelPullRequestAction,
  buildPullRequestReferenceContext,
  buildFixFindingHandoff,
  canDeletePullRequestBranch,
  buildFixFindingsHandoff,
  groupPullRequestTimelineConversations,
  filterPullRequestConversationItems,
  pagePullRequestConversationItems,
  pullRequestConversationItemComments,
  pullRequestConversationItems,
  handoffPrompt,
  handoffReviewComments,
  stripPullRequestHandoffReferences,
  isPullRequestVerdictStale,
  isStackedPullRequestBase,
  loadingPullRequestCheckoutCommand,
  pullRequestPanelContext,
  threadPullRequestPanelTarget,
  latestPullRequestReviewOutcomes,
  newestPullRequestCommitAt,
  mergePullRequestThreadComments,
  orderPullRequestComments,
  pullRequestCheckoutCommand,
  checkoutFailureDescription,
  readPullRequestDetailSnapshot,
  resolveDisplayedPullRequestDetail,
  resolvePullRequestReferenceHost,
  resolvePullRequestPrimaryControl,
  allowsSinglePullRequestMerge,
  shouldRefreshPullRequestActivity,
  resolveBaseFreshness,
  buildPullRequestTimeline,
  writePullRequestDetailSnapshot,
  readableFailure,
} from "./pullRequestDetail.logic";
import type { ReviewCommentContext } from "~/reviewCommentContext";

const TIMELINE_SOURCE: Pick<
  PullRequestDetailView,
  "provider" | "createdAt" | "author" | "commits" | "comments" | "mergedAt" | "closedAt"
> = {
  provider: SourceControlProviderKind.make("github"),
  createdAt: "2026-07-01T00:00:00Z",
  author: { login: "octocat", name: null, avatarUrl: null },
  commits: [
    { oid: "1baf7bdcafe", messageHeadline: "add the page", committedDate: "2026-07-02T00:00:00Z" },
  ],
  comments: [
    {
      id: "c1",
      kind: "issue-comment",
      author: { login: "bilal", name: null, avatarUrl: null },
      body: "looks good",
      createdAt: "2026-07-03T00:00:00Z",
      url: null,
      path: null,
      reviewState: null,
    },
  ],
  mergedAt: null,
  closedAt: null,
};

describe("cached pull request detail", () => {
  const reference = { projectId: ProjectId.make("project-1"), repository: "acme/web", number: 7 };
  const detail = (overrides: Partial<PullRequestDetail> = {}): PullRequestDetail =>
    ({
      provider: SourceControlProviderKind.make("github"),
      capabilities: {
        diff: true,
        comment: true,
        actions: ["merge"],
        mergeMethods: ["merge"],
        search: true,
        review: {
          inlineComment: true,
          reply: true,
          resolve: true,
          verdicts: ["comment", "approve", "request-changes"],
        },
        reviewers: { request: true, listCandidates: true },
      },
      viewerPermissions: {
        actions: ["merge"],
        comment: true,
        resolve: true,
        verdicts: ["comment", "approve", "request-changes"],
        requestReviewers: true,
      },
      projectId: "project-1",
      projectTitle: "web",
      workspaceRoot: "/repo",
      repository: "acme/web",
      number: 7,
      title: "Cache the title",
      body: "who made it",
      url: "https://github.com/acme/web/pull/7",
      author: { login: "octocat", name: null, avatarUrl: "https://avatars.example/octocat" },
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 12,
      deletions: 3,
      changedFiles: 2,
      headBranch: "feat/cache",
      baseBranch: "main",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-02T00:00:00.000Z",
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      labels: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
      ...overrides,
    }) as PullRequestDetail;

  const makeStorage = () => {
    const held = new Map<string, string>();
    return {
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
      size: () => held.size,
    };
  };

  it("keeps only the 20 most recently saved pull requests", () => {
    const storage = makeStorage();
    const numbered = (number: number) => ({ ...reference, number });
    for (let number = 1; number <= 21; number += 1) {
      writePullRequestDetailSnapshot(storage, "env-1", numbered(number), detail({ number }));
    }
    expect(readPullRequestDetailSnapshot(storage, "env-1", numbered(1))).toBeNull();
    expect(readPullRequestDetailSnapshot(storage, "env-1", numbered(2))?.number).toBe(2);
    expect(readPullRequestDetailSnapshot(storage, "env-1", numbered(21))?.number).toBe(21);
    expect(storage.size()).toBe(21);
  });

  it("saving a pull request again keeps it as the newest without growing the list", () => {
    const storage = makeStorage();
    const numbered = (number: number) => ({ ...reference, number });
    for (let number = 1; number <= 20; number += 1) {
      writePullRequestDetailSnapshot(storage, "env-1", numbered(number), detail({ number }));
    }
    writePullRequestDetailSnapshot(storage, "env-1", numbered(1), detail({ number: 1 }));
    writePullRequestDetailSnapshot(storage, "env-1", numbered(21), detail({ number: 21 }));
    expect(readPullRequestDetailSnapshot(storage, "env-1", numbered(1))?.number).toBe(1);
    expect(readPullRequestDetailSnapshot(storage, "env-1", numbered(2))).toBeNull();
    expect(storage.size()).toBe(21);
  });

  it("reuses a host-qualified snapshot when reopening a thread link without a host", () => {
    const storage = makeStorage();
    writePullRequestDetailSnapshot(
      storage,
      "env-1",
      { ...reference, host: "github.com" },
      detail(),
    );
    const resolved = resolvePullRequestReferenceHost(reference, {
      canonicalKey: "github.com/acme/web",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://github.com/acme/web.git",
      },
      provider: SourceControlProviderKind.make("github"),
    });
    expect(readPullRequestDetailSnapshot(storage, "env-1", resolved)?.title).toBe(
      "Cache the title",
    );
    const explicit = { ...reference, host: "github.example.com" };
    expect(
      resolvePullRequestReferenceHost(explicit, {
        canonicalKey: "github.com/acme/web",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/web.git",
        },
      }),
    ).toBe(explicit);
  });

  it("hydrates legacy hostless snapshots only for the matching host", () => {
    const storage = makeStorage();
    writePullRequestDetailSnapshot(storage, "env-1", reference, detail());
    expect(
      readPullRequestDetailSnapshot(storage, "env-1", { ...reference, host: "github.com" })?.title,
    ).toBe("Cache the title");
    expect(
      readPullRequestDetailSnapshot(storage, "env-1", {
        ...reference,
        host: "github.example.com",
      }),
    ).toBeNull();
  });

  it("keeps Forgejo ports isolated when recovering legacy snapshots", () => {
    const storage = makeStorage();
    const cached = detail({
      provider: SourceControlProviderKind.make("forgejo"),
      url: "https://forge.example:8443/acme/web/pulls/7",
    });
    writePullRequestDetailSnapshot(storage, "env-1", reference, cached);
    const resolved = { ...reference, host: "forge.example:8443" };
    expect(readPullRequestDetailSnapshot(storage, "env-1", resolved)?.title).toBe(cached.title);
    expect(
      readPullRequestDetailSnapshot(storage, "env-1", {
        ...reference,
        host: "forge.example:9443",
      }),
    ).toBeNull();
    expect(
      readPullRequestDetailSnapshot(storage, "env-1", {
        ...reference,
        host: "forge.example",
      }),
    ).toBeNull();
  });

  // regression: #12168 cached PR details were missed across entry points on custom ports
  it.each(["github", "gitlab"] as const)(
    "retains portless %s snapshot identities for custom web ports",
    (providerName) => {
      const provider = SourceControlProviderKind.make(providerName);
      const storage = makeStorage();
      const host = `${provider}.example.com`;
      const hosted = { ...reference, host };
      const cached = detail({
        provider,
        url: `https://${host}:8443/acme/web/${provider === "github" ? "pull" : "-/merge_requests"}/7`,
      });
      writePullRequestDetailSnapshot(storage, "env-1", hosted, cached);
      expect(readPullRequestDetailSnapshot(storage, "env-1", hosted)?.title).toBe(cached.title);
    },
  );

  it("does not paint another change request's snapshot", () => {
    expect(
      resolveDisplayedPullRequestDetail({
        live: null,
        cached: detail({ number: 8 }),
        reference,
      }),
    ).toBeNull();
    expect(readPullRequestDetailSnapshot(makeStorage(), "env-2", reference)).toBeNull();
  });

  it("isolates stored and displayed details between hosts with the same repository and number", () => {
    const storage = makeStorage();
    const publicRef = { ...reference, host: "github.com" };
    const enterpriseRef = { ...reference, host: "ghe.example.com" };
    const publicDetail = detail();
    const enterpriseDetail = detail({
      title: "Enterprise change",
      url: "https://ghe.example.com/acme/web/pull/7",
    });
    writePullRequestDetailSnapshot(storage, "env-1", publicRef, publicDetail);
    expect(readPullRequestDetailSnapshot(storage, "env-1", enterpriseRef)).toBeNull();
    writePullRequestDetailSnapshot(storage, "env-1", enterpriseRef, enterpriseDetail);
    expect(readPullRequestDetailSnapshot(storage, "env-1", publicRef)?.title).toBe(
      publicDetail.title,
    );
    expect(readPullRequestDetailSnapshot(storage, "env-1", enterpriseRef)?.title).toBe(
      enterpriseDetail.title,
    );
    expect(
      resolveDisplayedPullRequestDetail({
        live: null,
        cached: publicDetail,
        reference: enterpriseRef,
      }),
    ).toBeNull();
    expect(
      resolveDisplayedPullRequestDetail({
        live: null,
        cached: enterpriseDetail,
        reference: enterpriseRef,
      }),
    ).toBe(enterpriseDetail);
    writePullRequestDetailSnapshot(storage, "env-1", enterpriseRef, publicDetail);
    expect(readPullRequestDetailSnapshot(storage, "env-1", enterpriseRef)).toBeNull();
  });

  // regression: #9294 corrupt cached PR chrome broke reopening
  it("shrugs off corrupt storage and no storage at all", () => {
    const storage = makeStorage();
    storage.setItem("t3.pullRequests.detail:env-1:project-1:acme/web#7", "{not json");
    expect(readPullRequestDetailSnapshot(storage, "env-1", reference)).toBeNull();
    expect(readPullRequestDetailSnapshot(undefined, "env-1", reference)).toBeNull();
    const hosted = { ...reference, host: "github.com" };
    writePullRequestDetailSnapshot(storage, "env-1", hosted, detail({ url: "invalid url" }));
    expect(readPullRequestDetailSnapshot(storage, "env-1", hosted)).toBeNull();
  });
});

describe("single-PR merge compatibility during stack discovery", () => {
  it.each([
    [false, true, false, null, true],
    [false, false, true, null, true],
    [true, false, true, null, false],
    [true, false, false, "Lookup failed", false],
    [true, true, false, null, false],
    [true, false, false, null, true],
  ] as const)(
    "capability=%s stack=%s pending=%s error=%s permits=%s",
    (supportsStackActions, hasStack, stackPending, stackError, allowed) => {
      expect(
        allowsSinglePullRequestMerge({ supportsStackActions, hasStack, stackPending, stackError }),
      ).toBe(allowed);
    },
  );
});

describe("readableFailure", () => {
  it("replaces a host tool's bare failure with the hint, for every host", () => {
    for (const message of [
      "GitHub CLI failed.",
      "Azure DevOps API failed",
      "Forgejo command failed",
    ]) {
      expect(readableFailure(new Error(message), "Try again.")).toBe("Try again.");
    }
    expect(readableFailure(new Error("Branch is protected."), "Try again.")).toBe(
      "Branch is protected.",
    );
  });
});
