import { describe, expect, it } from "@effect/vitest";

import { parseCommits } from "./SourceControlPanelParsers.ts";

describe("SourceControlPanelParsers", () => {
  it("preserves empty and tab-containing commit subjects", () => {
    expect(
      parseCommits(
        [
          "full-empty\tshort-empty\tAda\tada@example.test\t2026-07-26T12:00:00Z\t",
          "full-tabs\tshort-tabs\tGrace\tgrace@example.test\t2026-07-26T13:00:00Z\tSubject\twith\ttabs",
        ].join("\n"),
      ),
    ).toEqual([
      {
        sha: "full-empty",
        shortSha: "short-empty",
        message: "",
        authorName: "Ada",
        authorEmail: "ada@example.test",
        authorAvatarUrl: null,
        authoredAt: "2026-07-26T12:00:00Z",
        headRefs: [],
        tags: [],
        files: [],
      },
      {
        sha: "full-tabs",
        shortSha: "short-tabs",
        message: "Subject\twith\ttabs",
        authorName: "Grace",
        authorEmail: "grace@example.test",
        authorAvatarUrl: null,
        authoredAt: "2026-07-26T13:00:00Z",
        headRefs: [],
        tags: [],
        files: [],
      },
    ]);
  });

  it("still rejects truncated commit records", () => {
    expect(parseCommits("full\tshort")).toEqual([]);
  });
});
