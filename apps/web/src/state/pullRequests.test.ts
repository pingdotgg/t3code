import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  ProjectId,
  PullRequestUnavailableError,
  PullRequestOperationError,
  type PullRequestListResult,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";

import {
  newestPullRequestObservation,
  newestPullRequestSummary,
  threadPullRequestLinkToSummary,
  observeFailedPullRequestList,
} from "./pullRequests";

it("observes both typed list failures without changing their status or replaying cached timestamps", () => {
  const listResult: PullRequestListResult = {
    viewers: {},
    providers: [],
    entries: [],
    errors: [],
    truncated: false,
    nextCursors: {},
  };
  const clock = vi.spyOn(Date, "now").mockReturnValue(100);
  try {
    for (const error of [
      new PullRequestUnavailableError({ reason: "cli-unauthenticated", listResult }),
      new PullRequestOperationError({ operation: "list", detail: "HTTP 403", listResult }),
    ]) {
      clock.mockReturnValue(100);
      const failure = AsyncResult.failure<PullRequestListResult, unknown>(Cause.fail(error));
      expect(observeFailedPullRequestList(failure)).toEqual({ value: listResult, observedAt: 100 });
      clock.mockReturnValue(200);
      expect(observeFailedPullRequestList(failure)?.observedAt).toBe(100);
      expect(failure._tag).toBe("Failure");
      expect(observeFailedPullRequestList({ ...failure, waiting: true })).toBeUndefined();
    }
    expect(
      observeFailedPullRequestList(
        AsyncResult.failure(Cause.fail(new PullRequestUnavailableError({ reason: "cli-missing" }))),
      ),
    ).toBeUndefined();
  } finally {
    clock.mockRestore();
  }
});

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
