import { expect, it } from "vite-plus/test";

import { forgejoComment, forgejoReview, forgejoReviewThread } from "./forgejoPullRequestJson.ts";

it.each([
  "https://forgejo.example/forgejo/team/repo/pulls/7#issuecomment-12",
  "https://gitea.example/team/repo/pulls/7#issuecomment-12",
  undefined,
])("preserves the comment link supplied by the host: %s", (url) => {
  const comment = {
    id: 12,
    body: "Please update this line.",
    user: null,
    created_at: "2026-09-13T10:00:00Z",
    ...(url ? { html_url: url } : {}),
  };
  expect(forgejoComment(comment).url).toBe(url ?? null);
  expect(
    forgejoReview({
      ...comment,
      state: "COMMENT",
      submitted_at: comment.created_at,
      comments_count: 1,
    }).url,
  ).toBe(url ?? null);
  expect(
    forgejoReviewThread({
      ...comment,
      path: "file.ts",
      position: 4,
      original_position: 4,
      commit_id: "head",
      original_commit_id: "head",
      resolver: null,
    }).comments[0]?.url,
  ).toBe(url ?? null);
});
