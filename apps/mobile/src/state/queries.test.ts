import { filterComposerPullRequestMatches } from "@t3tools/shared/composerPullRequestMatches";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { buildCheckpointDiffTargets, normalizeComposerPathSearchQuery } from "./queryTargets";

describe("appQueries", () => {
  it("normalizes composer path search input", () => {
    expect(normalizeComposerPathSearchQuery("  src/app  ")).toBe("src/app");
    expect(normalizeComposerPathSearchQuery(null)).toBe("");
  });

  it("routes the first turn range through the full-thread diff query", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-a");

    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 4,
        ignoreWhitespace: true,
      }),
    ).toEqual({
      fullThread: {
        environmentId,
        input: {
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        },
      },
      turn: null,
    });
  });

  it("routes later ranges through the incremental turn diff query", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-a");

    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 3,
        toTurnCount: 4,
        ignoreWhitespace: false,
      }),
    ).toEqual({
      fullThread: null,
      turn: {
        environmentId,
        input: {
          threadId,
          fromTurnCount: 3,
          toTurnCount: 4,
          ignoreWhitespace: false,
        },
      },
    });
  });
});

it("keeps an older exact PR in the mobile menu ahead of twenty newer substring matches", () => {
  const exact = {
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
