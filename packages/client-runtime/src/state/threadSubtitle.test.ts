import { describe, expect, it } from "vite-plus/test";

import { displayThreadSubtitle, threadSubtitleMatches } from "./threadSubtitle.ts";

describe("thread subtitles", () => {
  it("hides empty and title-duplicating subtitles", () => {
    expect(displayThreadSubtitle({ title: "Session grid", subtitle: "  " })).toBeNull();
    expect(displayThreadSubtitle({ title: "Session grid", subtitle: "session grid" })).toBeNull();
  });

  it("normalizes and searches useful subtitles", () => {
    const thread = { title: "Session grid", subtitle: "  running   focused tests  " };
    expect(displayThreadSubtitle(thread)).toBe("running focused tests");
    expect(threadSubtitleMatches(thread, "focused")).toBe(true);
  });
});
