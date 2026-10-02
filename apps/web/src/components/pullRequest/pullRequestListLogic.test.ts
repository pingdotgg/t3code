import { describe, expect, it } from "vitest";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  buildPullRequestListItems,
  dedupePullRequestEntries,
  hasSearchQualifier,
  isProvisionalSearch,
  mergePullRequestPages,
  narrowEntriesLocally,
  pullRequestEntryKey,
  selectVisibleStatsEntries,
  type PullRequestListRowEntry,
} from "./pullRequestListLogic";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");
const PROJECT_A = ProjectId.make("project-a");

function row(overrides: Partial<PullRequestListRowEntry> = {}): PullRequestListRowEntry {
  return {
    provider: "github",
    host: "github.com",
    projectId: PROJECT_A,
    projectTitle: "T3 Code",
    repository: "t3tools/t3code",
    number: 42,
    title: "Improve pull request navigation",
    url: "https://github.com/t3tools/t3code/pull/42",
    author: { login: "octocat", name: "The Octocat", avatarUrl: null },
    headBranch: "feature/pull-requests",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 12,
    deletions: 3,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    viewerReviewRequested: false,
    labels: [],
    environmentId: ENVIRONMENT_A,
    ...overrides,
  };
}

describe("pullRequestListLogic", () => {
  it("keys rows by environment and complete PR identity", () => {
    const left = row();
    const otherEnv = row({ environmentId: ENVIRONMENT_B });
    const otherCase = row({ repository: "T3Tools/T3Code" });

    expect(pullRequestEntryKey(left)).toBe(pullRequestEntryKey(otherCase));
    expect(pullRequestEntryKey(left)).not.toBe(pullRequestEntryKey(otherEnv));
    expect(pullRequestEntryKey(left)).not.toBe(pullRequestEntryKey(row({ number: 43 })));
  });

  it("dedupes repeated rows across pages and environments without reordering", () => {
    const first = row({ number: 1 });
    const second = row({ number: 2 });
    const duplicate = row({ number: 1, title: "stale duplicate" });

    expect(dedupePullRequestEntries([first, second, duplicate])).toEqual([first, second]);
  });

  it("merges progressive pages without losing earlier rows", () => {
    const existing = [row({ number: 1 }), row({ number: 2 })];
    const incoming = [row({ number: 2, title: "dup" }), row({ number: 3 })];

    expect(mergePullRequestPages(existing, incoming)).toEqual([
      existing[0]!,
      existing[1]!,
      row({ number: 3 }),
    ]);
  });

  it("detects GitHub qualifiers so local narrowing skips them", () => {
    expect(hasSearchQualifier("label:bug")).toBe(true);
    expect(hasSearchQualifier("author:octocat fix")).toBe(true);
    expect(hasSearchQualifier("is:open review")).toBe(true);
    expect(hasSearchQualifier("LABEL:BUG")).toBe(true);
    expect(hasSearchQualifier("fix login")).toBe(false);
    expect(hasSearchQualifier("")).toBe(false);
  });

  it("treats ordinary titles with colons as plain text, not operators", () => {
    expect(hasSearchQualifier("fix: login redirect")).toBe(false);
    expect(hasSearchQualifier("chore: bump deps")).toBe(false);
    const entries = [
      row({ number: 1, title: "Fix login redirect" }),
      row({ number: 2, title: "Update docs" }),
    ];

    // Narrows immediately instead of flashing the full unfiltered list
    // while the debounced server query is on its way.
    expect(narrowEntriesLocally(entries, "fix: login")).not.toBe(entries);
  });

  it("narrows plain text locally but leaves qualifier searches to the server", () => {
    const entries = [
      row({ number: 1, title: "Fix login redirect" }),
      row({ number: 2, title: "Update docs" }),
    ];

    expect(narrowEntriesLocally(entries, "fix")).toEqual([entries[0]]);
    expect(narrowEntriesLocally(entries, "label:bug")).toBe(entries);
    expect(narrowEntriesLocally(entries, "")).toBe(entries);
  });

  it("matches repository and number substrings locally", () => {
    const entries = [row({ repository: "t3tools/t3code", number: 42 })];

    expect(narrowEntriesLocally(entries, "t3code")).toHaveLength(1);
    expect(narrowEntriesLocally(entries, "42")).toHaveLength(1);
    expect(narrowEntriesLocally(entries, "nope")).toHaveLength(0);
  });

  it("reports provisional narrowing only while the server query lags", () => {
    expect(isProvisionalSearch("fix", "fi")).toBe(true);
    expect(isProvisionalSearch("fix", "fix")).toBe(false);
    expect(isProvisionalSearch("", "")).toBe(false);
  });

  it("requests diff stats for the visible window, not every loaded row", () => {
    const entries = [row({ number: 1 }), row({ number: 2 }), row({ number: 3 })];

    expect(selectVisibleStatsEntries(entries, new Set(), 120, 50)).toEqual(entries);
    expect(
      selectVisibleStatsEntries(entries, new Set([pullRequestEntryKey(entries[2]!)]), 120, 50),
    ).toEqual([entries[2]]);
    expect(selectVisibleStatsEntries(entries, new Set(["unknown"]), 120, 50)).toEqual(entries);
    expect(
      selectVisibleStatsEntries(entries, new Set(entries.map(pullRequestEntryKey)), 1, 50),
    ).toHaveLength(1);
  });

  it("builds a flat virtualized list preserving section headers and stable keys", () => {
    const awaiting = row({ number: 1, viewerReviewRequested: true });
    const other = row({ number: 2 });
    const items = buildPullRequestListItems([awaiting], [other]);

    expect(items.map((item) => item.key)).toEqual([
      "header:awaiting",
      pullRequestEntryKey(awaiting),
      "header:others",
      pullRequestEntryKey(other),
    ]);
    expect(items[0]?.kind).toBe("header");
    expect(items[1]?.kind).toBe("row");
  });

  it("omits empty sections so virtualization never renders bare headings", () => {
    const other = row({ number: 2 });
    const items = buildPullRequestListItems([], [other]);

    expect(items.map((item) => item.kind)).toEqual(["header", "row"]);
    expect(items[0]).toMatchObject({ key: "header:others" });
    expect(buildPullRequestListItems([], [])).toEqual([]);
  });
});
