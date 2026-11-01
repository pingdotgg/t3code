import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestListEntry,
  type PullRequestListInput,
  type PullRequestListResult,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  newestPullRequestObservation,
  observedPullRequestSummary,
  observePullRequestChecks,
  observePullRequestMetadata,
  newestPullRequestSummary,
  rememberPullRequestListAnswer,
  restorePullRequestList,
  restoredPullRequestList,
  threadPullRequestLinkToSummary,
} from "./pullRequests";

function summary(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    provider: SourceControlProviderKind.make("github"),
    projectId: ProjectId.make("pull-request-cache-test"),
    repository: "acme/widget",
    number: 7,
    title: "Improve widget",
    url: "https://github.com/acme/widget/pull/7",
    state: "open",
    isDraft: false,
    headBranch: "improve-widget",
    baseBranch: "main",
    updatedAt: "2026-09-10T00:00:00Z",
    author: { login: "oliver", name: null, avatarUrl: null },
    mergeability: "mergeable",
    checksState: "passing",
    ...overrides,
  };
}

const observed = (value: PullRequestSummary, observedAt: number) => ({
  summary: value,
  observedAt,
});

describe("pull request summary cache", () => {
  it("orders same-dated snapshots by the server's read time, not by arrival", () => {
    const stale = observed(summary({ observedAt: 200 }), 500);
    const held = observed(
      summary({ mergeability: "conflicting", checksState: "failing", observedAt: 300 }),
      100,
    );
    expect(newestPullRequestObservation(stale, held)?.summary).toMatchObject({
      mergeability: "conflicting",
      checksState: "failing",
      observedAt: 300,
    });
    expect(newestPullRequestObservation(held, stale)).toBe(held);
    expect(newestPullRequestObservation(held, { ...held, observedAt: 900 })).toBe(held);
  });

  it("uses arrival order only when neither snapshot carries a server read time", () => {
    const first = observed(summary(), 100);
    const later = observed(summary({ checksState: "failing" }), 200);
    expect(newestPullRequestObservation(first, later)).toMatchObject({ observedAt: 200 });
    expect(newestPullRequestObservation(later, first)).toBe(later);
    const stamped = observed(summary({ observedAt: 50 }), 1);
    expect(newestPullRequestObservation(later, stamped)?.summary.observedAt).toBe(50);
    expect(newestPullRequestObservation(stamped, later)).toBe(stamped);
  });

  it("keeps known status when a newer snapshot omits it, and clears it when told to", () => {
    const list = observed(summary({ reviewDecision: "approved", observedAt: 100 }), 100);
    const sparse = observed(
      summary({ checksState: undefined, reviewDecision: undefined, observedAt: 200 }),
      200,
    );
    expect(newestPullRequestObservation(list, sparse)?.summary).toMatchObject({
      checksState: "passing",
      reviewDecision: "approved",
    });
    const cleared = observed(summary({ checksState: null, observedAt: 300 }), 300);
    expect(newestPullRequestObservation(list, cleared)?.summary.checksState).toBeNull();
  });

  it("treats merged as final and otherwise prefers the later host update", () => {
    const merged = summary({ state: "merged", updatedAt: "2026-09-01T00:00:00Z" });
    const reopened = summary({ updatedAt: "2026-09-12T00:00:00Z", observedAt: 900 });
    expect(newestPullRequestSummary(merged, reopened)).toBe(merged);
    expect(newestPullRequestSummary(reopened, merged)).toBe(merged);
    const older = summary({ updatedAt: "2026-09-11T00:00:00Z", observedAt: 999 });
    expect(newestPullRequestSummary(older, reopened)).toBe(reopened);
    expect(newestPullRequestSummary(reopened, older)).toBe(reopened);
  });

  it("reuses saved thread state while detail is stale and lets newer detail replace it", () => {
    const stale = summary();
    const link = {
      host: "github.com",
      repository: stale.repository,
      number: stale.number,
      url: stale.url,
      source: "manual" as const,
      linkedAt: stale.updatedAt,
      stack: null,
      snapshot: {
        ...stale,
        state: "closed" as const,
        isDraft: false,
        updatedAt: "2026-09-11T00:00:00Z",
        syncedAt: "2026-09-12T00:00:00Z",
      },
    };
    const saved = threadPullRequestLinkToSummary(link, stale.projectId);
    expect(newestPullRequestSummary(stale, saved)?.state).toBe("closed");
    const fresh = summary({ isDraft: true, updatedAt: "2026-09-13T00:00:00Z" });
    expect(newestPullRequestSummary(fresh, saved)).toBe(fresh);
    expect(threadPullRequestLinkToSummary({ ...link, snapshot: null }, stale.projectId)).toBeNull();
    expect(
      threadPullRequestLinkToSummary(
        { ...link, snapshot: { ...link.snapshot, updatedAt: null } },
        stale.projectId,
      ),
    ).toBeNull();
  });
});

describe("pull request observations", () => {
  const fromSummary = (value: PullRequestSummary, observedAt: number) =>
    observePullRequestMetadata({ metadata: null, checks: null }, observed(value, observedAt));
  const checksRead = (
    checksState: "passing" | "failing" | "pending" | null,
    readAt: number | undefined,
    observedAt: number,
  ) => ({ checksState, readAt, observedAt });

  it("keeps a newer list's mergeability when a checks read lands after it", () => {
    const detail = summary({
      mergeability: "conflicting",
      checksState: "pending",
      observedAt: 100,
    });
    let state = fromSummary(detail, 1);
    state = observePullRequestMetadata(
      state,
      observed(summary({ mergeability: "mergeable", checksState: "pending", observedAt: 200 }), 2),
    );
    state = observePullRequestChecks(state, checksRead("passing", 300, 3));
    expect(observedPullRequestSummary(state)).toMatchObject({
      mergeability: "mergeable",
      checksState: "passing",
    });
  });

  it("keeps a newer checks read when an older list read lands after it", () => {
    let state = fromSummary(
      summary({ mergeability: "conflicting", checksState: "pending", observedAt: 100 }),
      1,
    );
    state = observePullRequestChecks(state, checksRead("passing", 300, 2));
    state = observePullRequestMetadata(
      state,
      observed(summary({ mergeability: "mergeable", checksState: "pending", observedAt: 250 }), 3),
    );
    expect(observedPullRequestSummary(state)).toMatchObject({
      mergeability: "mergeable",
      checksState: "passing",
    });
  });

  it("lets a newer read's checks replace an older checks read", () => {
    let state = fromSummary(summary({ checksState: "pending", observedAt: 100 }), 1);
    state = observePullRequestChecks(state, checksRead("passing", 300, 2));
    state = observePullRequestMetadata(
      state,
      observed(summary({ checksState: "failing", observedAt: 400 }), 3),
    );
    expect(observedPullRequestSummary(state)?.checksState).toBe("failing");
  });

  it("orders checks by arrival when the server reports no read time", () => {
    let state = fromSummary(summary({ checksState: "pending" }), 1);
    state = observePullRequestChecks(state, checksRead("passing", undefined, 2));
    expect(observedPullRequestSummary(state)?.checksState).toBe("passing");
    state = observePullRequestChecks(state, checksRead("failing", undefined, 1));
    expect(observedPullRequestSummary(state)?.checksState).toBe("passing");
  });

  it("shows nothing until some read has described the pull request", () => {
    const state = observePullRequestChecks(
      { metadata: null, checks: null },
      checksRead("failing", 1, 1),
    );
    expect(observedPullRequestSummary(state)).toBeNull();
  });
});

describe("pull request list answers across a reload", () => {
  const makeStorage = () => {
    const held = new Map<string, string>();
    return {
      held,
      getItem: (key: string) => held.get(key) ?? null,
      setItem: (key: string, value: string) => void held.set(key, value),
      removeItem: (key: string) => void held.delete(key),
      key: (index: number) => [...held.keys()][index] ?? null,
      get length() {
        return held.size;
      },
    };
  };
  const listEntry = (number: number, updatedAt = "2026-07-02T00:00:00Z") =>
    ({
      provider: SourceControlProviderKind.make("github"),
      host: "github.com",
      projectId: ProjectId.make("project-1"),
      projectTitle: "t3code",
      repository: "pingdotgg/t3code",
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/pingdotgg/t3code/pull/${number}`,
      author: { login: "octocat", name: null, avatarUrl: null },
      headBranch: `feat/branch-${number}`,
      baseBranch: "main",
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 0,
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt,
      viewerReviewRequested: false,
      labels: [],
    }) as PullRequestListEntry;
  const answer = (entries: ReadonlyArray<PullRequestListEntry>, host = "github.com") =>
    ({
      entries,
      viewers: { [host]: "Bilal" },
      providers: [
        {
          host,
          kind: SourceControlProviderKind.make("github"),
          searchesOnHost: true,
          projectCount: 1,
          configured: true,
          detail: null,
        },
      ],
      errors: [{ projectId: ProjectId.make("project-1"), projectTitle: "t3code", message: "boom" }],
      truncated: true,
      nextCursors: { "pingdotgg/t3code": "cursor-1" },
    }) as PullRequestListResult;
  const local = EnvironmentId.make("env-local");
  const remote = EnvironmentId.make("env-remote");
  const input: PullRequestListInput = { state: "open", involvement: "all", limit: 99 };

  it("restores every environment's first page as one merged list without stale failures or cursors", () => {
    const storage = makeStorage();
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input },
      answer([listEntry(1, "2026-07-01T00:00:00Z")]),
    );
    rememberPullRequestListAnswer(
      storage,
      { environmentId: remote, input },
      answer([listEntry(2, "2026-07-03T00:00:00Z")], "gitlab.com"),
    );
    const restored = restorePullRequestList(storage, [
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);
    expect(restored?.entries.map((row) => [row.environmentId, row.number])).toEqual([
      [remote, 2],
      [local, 1],
    ]);
    expect(restored?.viewers).toEqual({
      "env-local github.com": "Bilal",
      "env-remote gitlab.com": "Bilal",
    });
    expect(restored?.providers.map((provider) => provider.host)).toEqual([
      "github.com",
      "gitlab.com",
    ]);
    expect(restored?.errors).toEqual([]);
    expect(restored?.nextCursors).toEqual({});
  });

  it("falls back to a fresh read when the browser blocks storage", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    try {
      expect(restoredPullRequestList([{ environmentId: local, input }])).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a page of rows and only first-page reads", () => {
    const storage = makeStorage();
    const rows = Array.from({ length: 120 }, (_, index) => listEntry(index + 1));
    rememberPullRequestListAnswer(storage, { environmentId: local, input }, answer(rows));
    const searched = { ...input, query: "fix" };
    rememberPullRequestListAnswer(storage, { environmentId: local, input: searched }, answer(rows));
    const continued = { ...input, cursors: { "pingdotgg/t3code": "cursor-1" } };
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input: continued },
      answer(rows),
    );
    expect(
      restorePullRequestList(storage, [{ environmentId: local, input }])?.entries,
    ).toHaveLength(99);
    expect(restorePullRequestList(storage, [{ environmentId: local, input: searched }])).toBeNull();
    expect(
      restorePullRequestList(storage, [{ environmentId: local, input: continued }]),
    ).toBeNull();
  });

  it("restores answers kept under a project assignment for a cold start that has none yet", () => {
    const storage = makeStorage();
    rememberPullRequestListAnswer(
      storage,
      {
        environmentId: local,
        input: { ...input, projectIds: [ProjectId.make("project-1")] },
      },
      answer([listEntry(1)]),
    );
    rememberPullRequestListAnswer(
      storage,
      {
        environmentId: remote,
        input: { ...input, projectIds: [ProjectId.make("project-2")] },
      },
      answer([listEntry(2, "2026-07-03T00:00:00Z")]),
    );
    const restored = restorePullRequestList(storage, [
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);
    expect(restored?.entries.map((row) => [row.environmentId, row.number])).toEqual([
      [remote, 2],
      [local, 1],
    ]);
  });

  it("shows a pull request once when answers from before a reassignment overlap", () => {
    const storage = makeStorage();
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input },
      answer([listEntry(1, "2026-07-01T00:00:00Z")]),
    );
    rememberPullRequestListAnswer(
      storage,
      { environmentId: remote, input },
      answer([listEntry(1, "2026-07-03T00:00:00Z")]),
    );
    const restored = restorePullRequestList(storage, [
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);
    expect(restored?.entries.map((row) => [row.environmentId, row.updatedAt])).toEqual([
      [remote, "2026-07-03T00:00:00Z"],
    ]);
  });

  it("keeps a shared repository's rows when it moves to an environment that has not answered yet", () => {
    const storage = makeStorage();
    const own = ProjectId.make("project-own");
    const shared = { ...listEntry(2), projectId: ProjectId.make("project-shared") };
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input },
      answer([{ ...listEntry(1), projectId: own }, shared]),
    );
    rememberPullRequestListAnswer(
      storage,
      { environmentId: remote, input },
      answer([listEntry(3, "2026-07-03T00:00:00Z")]),
    );
    // The shared repository now belongs to the remote environment, which has not answered yet.
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input: { ...input, projectIds: [own] } },
      answer([{ ...listEntry(1), projectId: own }]),
    );
    const restored = restorePullRequestList(storage, [
      { environmentId: local, input },
      { environmentId: remote, input },
    ]);
    expect(restored?.entries.map((row) => row.number).toSorted()).toEqual([1, 2, 3]);
  });

  it("keeps one page per environment when retained rows join a partial answer", () => {
    const storage = makeStorage();
    const own = ProjectId.make("project-own");
    const shared = ProjectId.make("project-shared");
    const rows = (projectId: ProjectId, first: number) =>
      Array.from({ length: 99 }, (_, index) => ({ ...listEntry(first + index), projectId }));
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input },
      answer(rows(shared, 1)),
    );
    rememberPullRequestListAnswer(
      storage,
      { environmentId: local, input: { ...input, projectIds: [own] } },
      answer(rows(own, 101)),
    );
    const restored = restorePullRequestList(storage, [{ environmentId: local, input }]);
    expect(restored?.entries).toHaveLength(99);
    expect(restored?.entries.every((row) => row.projectId === own)).toBe(true);
  });

  it("does not keep grown pages", () => {
    const storage = makeStorage();
    const grown = { ...input, limit: 198 };
    rememberPullRequestListAnswer(storage, { environmentId: local, input: grown }, answer([]));
    expect(restorePullRequestList(storage, [{ environmentId: local, input: grown }])).toBeNull();
  });

  it("forgets whole scopes, never one environment of a scope that is kept", () => {
    const storage = makeStorage();
    const scoped = (projectIndex: number) => ({
      ...input,
      projectId: ProjectId.make(`p-${projectIndex}`),
    });
    for (let projectIndex = 0; projectIndex < 9; projectIndex++) {
      for (const [offset, environmentId] of [local, remote].entries()) {
        rememberPullRequestListAnswer(
          storage,
          { environmentId, input: scoped(projectIndex) },
          answer([listEntry(projectIndex * 2 + offset + 1, `2026-07-0${2 - offset}T00:00:00Z`)]),
        );
      }
    }
    const restore = (projectIndex: number) =>
      restorePullRequestList(storage, [
        { environmentId: local, input: scoped(projectIndex) },
        { environmentId: remote, input: scoped(projectIndex) },
      ]);
    expect(restore(0)).toBeNull();
    for (let projectIndex = 1; projectIndex < 9; projectIndex++) {
      expect(restore(projectIndex)?.entries.map((row) => row.environmentId)).toEqual([
        local,
        remote,
      ]);
    }
  });

  it("removes the composite snapshots it replaced", () => {
    const storage = makeStorage();
    storage.held.set("t3.pullRequests.list:env-local,env-remote", "{}");
    storage.held.set("t3.pullRequests.list:env-local", "{}");
    storage.held.set("t3.other", "kept");
    rememberPullRequestListAnswer(storage, { environmentId: local, input }, answer([]));
    expect(
      [...storage.held.keys()].filter((key) => key.startsWith("t3.pullRequests.list:")),
    ).toEqual([]);
    expect(storage.held.get("t3.other")).toBe("kept");
  });
});
