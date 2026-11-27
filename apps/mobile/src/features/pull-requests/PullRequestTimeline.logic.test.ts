import { expect, it } from "vite-plus/test";

import { collapsedTimelineCommentMarkdown } from "./PullRequestTimeline.logic";

it("keeps emoji whole at the collapsed comment preview limit", () => {
  const prefix = "a".repeat(1199);

  expect(collapsedTimelineCommentMarkdown(`${prefix}😀 trailing`)).toBe(prefix);
});
