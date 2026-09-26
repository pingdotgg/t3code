import { ProjectId, type PullRequestSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { newestPullRequestObservation, newestPullRequestSummary } from "./pullRequests";

function summary(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    provider: "github",
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
    // An older filtered or server-cached response finishing last must not roll status back.
    expect(newestPullRequestObservation(held, stale)).toBe(held);
    // The same read seen again is not a new observation.
    expect(newestPullRequestObservation(held, { ...held, observedAt: 900 })).toBe(held);
  });

  it("uses arrival order only when neither snapshot carries a server read time", () => {
    const first = observed(summary(), 100);
    const later = observed(summary({ checksState: "failing" }), 200);
    expect(newestPullRequestObservation(first, later)).toMatchObject({ observedAt: 200 });
    expect(newestPullRequestObservation(later, first)).toBe(later);
    // A stamped read beats an unstamped one regardless of which arrived last.
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
});
