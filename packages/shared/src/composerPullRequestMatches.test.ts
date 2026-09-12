import { describe, expect, it } from "vite-plus/test";

import { filterComposerPullRequestMatches } from "./composerPullRequestMatches.ts";

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

  it("leaves the caller's array untouched", () => {
    // The sort runs on a copy; mutating the input would reorder whatever the caller holds.
    const entries = [entry(2, "2026-01-01"), entry(1, "2026-01-02")];
    const snapshot = entries.map((match) => match.number);
    filterComposerPullRequestMatches({
      entries,
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 10,
    });
    expect(entries.map((match) => match.number)).toEqual(snapshot);
  });

  it("de-duplicates and honours the limit", () => {
    const result = filterComposerPullRequestMatches({
      entries: [entry(7, "2026-01-02"), entry(7, "2026-01-01"), entry(8, "2026-01-03")],
      projectId: "p1",
      repository: "owner/repo",
      query: "",
      limit: 1,
    });
    expect(result).toHaveLength(1);
  });
});
