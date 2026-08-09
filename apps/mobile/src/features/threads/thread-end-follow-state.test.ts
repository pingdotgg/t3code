import { describe, expect, it } from "@effect/vitest";

import {
  initialThreadEndFollowState,
  reduceThreadEndFollowState,
  threadEndFollowEnabled,
} from "./thread-end-follow-state";

describe("thread end-follow state", () => {
  it("starts a newly selected thread with end-follow enabled", () => {
    const previousThreadState = reduceThreadEndFollowState(
      initialThreadEndFollowState("thread-a"),
      { type: "observed", threadKey: "thread-a", enabled: false },
    );

    expect(threadEndFollowEnabled(previousThreadState, "thread-b")).toBe(true);
  });

  it("re-arms end-follow before scrolling to the end", () => {
    const scrolledAwayState = reduceThreadEndFollowState(initialThreadEndFollowState("thread-a"), {
      type: "observed",
      threadKey: "thread-a",
      enabled: false,
    });
    const scrollToEndState = reduceThreadEndFollowState(scrolledAwayState, {
      type: "scrollToEnd",
      threadKey: "thread-a",
    });

    expect(threadEndFollowEnabled(scrollToEndState, "thread-a")).toBe(true);
  });
});
