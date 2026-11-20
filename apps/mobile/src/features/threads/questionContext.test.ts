import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { feedWithoutOpenQuestionRow } from "./questionContext";

const activity = (requestId: string, answered: boolean) => ({
  workEntry: {
    structuredPayload: {
      type: "user_input_request",
      requestId,
      ...(answered ? { questionAnswer: {} } : {}),
    },
  },
});
const group = (id: string, ...activities: ReadonlyArray<ReturnType<typeof activity>>) =>
  ({ type: "activity-group", id, activities }) as unknown as ThreadFeedEntry;

describe("feedWithoutOpenQuestionRow", () => {
  it("drops the open question's row, and a group left empty", () => {
    const feed = [group("a", activity("r1", false)), group("b", activity("r0", true))];
    expect(feedWithoutOpenQuestionRow(feed, "r1")).toEqual([feed[1]]);
  });

  it("keeps the group's other rows, answered questions, and the feed when nothing is open", () => {
    const keep = activity("r2", false);
    const feed = [group("a", activity("r1", false), keep)];
    const [kept] = feedWithoutOpenQuestionRow(feed, "r1");
    expect(kept).toMatchObject({ id: "a", activities: [keep] });
    expect(feedWithoutOpenQuestionRow(feed, null)).toBe(feed);
    expect(feedWithoutOpenQuestionRow([group("b", activity("r1", true))], "r1")).toHaveLength(1);
  });
});
