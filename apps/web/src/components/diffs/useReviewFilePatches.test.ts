import { EnvironmentId, type ReviewDiffPreviewSource } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { reviewFilePatchScope, reviewFileQueries } from "./useReviewFilePatches";

it("retains requested files and their loaded query atoms when another file changes", () => {
  const source: ReviewDiffPreviewSource = {
    id: "working-tree",
    kind: "working-tree",
    title: "Working tree",
    baseRef: null,
    headRef: null,
    diff: "",
    diffHash: "before",
    truncated: true,
    files: Array.from({ length: 6 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      previousPath: null,
      additions: 1,
      deletions: 1,
    })),
  };
  const input = {
    environmentId: EnvironmentId.make("local"),
    cwd: "/workspace",
    source,
    baseRef: null,
    ignoreWhitespace: false,
    previewInput: { cwd: "/workspace", ignoreWhitespace: false },
  };
  const scope = reviewFilePatchScope(input);
  const requested = { scope, indices: [0, 1, 2, 3, 4, 5] };
  const before = reviewFileQueries({ ...input, scope, requested });
  const updated = { ...input, source: { ...source, diffHash: "after" } };
  const after = reviewFileQueries({
    ...updated,
    scope: reviewFilePatchScope(updated),
    requested,
  });

  expect
    .soft(after.map(({ target }) => target.input.request.file.path))
    .toEqual(before.map(({ target }) => target.input.request.file.path));
  expect
    .soft(
      before.map(
        ({ index, query }) => after.find((entry) => entry.index === index)?.query === query,
      ),
    )
    .toEqual(before.map(() => true));
});
