import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  clearTimelineScrollPosition,
  clearTimelineScrollStateForTests,
  readTimelineScrollPosition,
  rememberTimelineScrollPosition,
} from "./timelineScrollState";

describe("timeline scroll state", () => {
  beforeEach(clearTimelineScrollStateForTests);

  it("keeps independent positions for each thread", () => {
    rememberTimelineScrollPosition("environment:thread-a", 420);
    rememberTimelineScrollPosition("environment:thread-b", 860);

    expect(readTimelineScrollPosition("environment:thread-a")).toBe(420);
    expect(readTimelineScrollPosition("environment:thread-b")).toBe(860);

    clearTimelineScrollPosition("environment:thread-a");
    expect(readTimelineScrollPosition("environment:thread-a")).toBeNull();
    expect(readTimelineScrollPosition("environment:thread-b")).toBe(860);
  });
});
