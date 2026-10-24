import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewFileQueries } from "./useReviewFilePatches";

const source: ReviewDiffPreviewSource = {
  id: "abc123",
  kind: "commit",
  title: "Commit abc123",
  baseRef: "abc123^",
  headRef: "abc123",
  diff: "",
  diffHash: "commit-diff",
  truncated: true,
  files: [5, 4, 3, 2, 1].map((index) => ({
    path: `src/file${index}.ts`,
    previousPath: index === 1 ? "src/old.ts" : null,
    additions: 10,
    deletions: 1,
  })),
};
const input = {
  environmentId: EnvironmentId.make("environment-review-patches-test"),
  cwd: "/workspace",
  source,
  baseRef: "origin/release",
  ignoreWhitespace: true,
  scope: "commit-scope",
  requested: { scope: "previous-scope", indices: [4] },
};

describe("reviewFileQueries", () => {
  it("loads the selected commit's files with the remembered comparison base and bounded initial batch", () => {
    const queries = reviewFileQueries(input);

    expect(queries.map(({ target }) => target.input.request.file.path)).toEqual([
      "src/file1.ts",
      "src/file2.ts",
      "src/file3.ts",
      "src/file4.ts",
    ]);
    expect(queries[0]?.target).toEqual({
      environmentId: input.environmentId,
      input: {
        cacheKey: input.scope,
        request: {
          cwd: input.cwd,
          baseRef: "origin/release",
          commitSha: "abc123",
          ignoreWhitespace: true,
          file: { path: "src/file1.ts", previousPath: "src/old.ts", sourceKind: "commit" },
        },
      },
    });
    expect(reviewFileQueries(input)[0]?.query).toBe(queries[0]?.query);

    const next = reviewFileQueries({
      ...input,
      requested: { scope: input.scope, indices: [4, 5] },
    });
    expect(next.map(({ target }) => target.input.request.file.path)).toEqual(["src/file5.ts"]);
    expect(next[0]?.target.input.request.commitSha).toBe("abc123");
  });

  it.each(["branch-range", "working-tree"] as const)(
    "keeps %s requests free of commit selection",
    (kind) => {
      const queries = reviewFileQueries({ ...input, source: { ...source, kind } });
      expect(queries[0]?.target.input.request).not.toHaveProperty("commitSha");
      expect(queries[0]?.target.input.request.file.sourceKind).toBe(kind);
    },
  );
});
