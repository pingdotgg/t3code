import { threadPullRequestKeyOf } from "@t3tools/client-runtime/thread-pull-requests";
import { filterComposerPullRequestMatches } from "@t3tools/shared/composerPullRequestMatches";
import { expect, it } from "@effect/vitest";

it("keeps an older exact PR in the mobile menu ahead of twenty newer substring matches", () => {
  const exact = {
    host: "github.com",
    number: 42,
    projectId: "project",
    repository: "example/repo",
    updatedAt: "2025-01-01",
  };
  const recent = Array.from({ length: 25 }, (_, index) => ({
    ...exact,
    number: 4200 + index,
    updatedAt: "2026-01-01",
  }));
  const matches = filterComposerPullRequestMatches({
    keyOf: threadPullRequestKeyOf,
    entries: [exact, ...recent, exact],
    projectId: exact.projectId,
    repository: exact.repository,
    query: "42",
    limit: 20,
  });
  expect(matches).toHaveLength(20);
  expect(matches[0]).toEqual(exact);
  expect(matches.filter((entry) => entry.number === 42)).toHaveLength(1);
});
