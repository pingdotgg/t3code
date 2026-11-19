import { describe, expect, it } from "vite-plus/test";

import { readerLineScrollTop } from "./timelineReaderLine";

// 3000 px of content in a 600 px view: the scroll range ends at 2400.
const geometry = (scrollTop: number) => ({ scrollTop, scrollHeight: 3000, clientHeight: 600 });

describe("readerLineScrollTop", () => {
  it.each([
    { name: "moves down by the drift", scrollTop: 1000, drift: 51, target: 1051 },
    { name: "moves up by the drift", scrollTop: 1000, drift: -45, target: 955 },
    { name: "skips a move under half a pixel", scrollTop: 1000, drift: 0.4, target: null },
    { name: "keeps a half-pixel move", scrollTop: 1000, drift: -0.5, target: 999.5 },
    { name: "stops at the end", scrollTop: 2000, drift: 500, target: 2400 },
    { name: "leaves a list inside the end band in place", scrollTop: 2390, drift: 0, target: null },
    { name: "has nothing to move at the end", scrollTop: 2400, drift: 20, target: null },
    { name: "stops at the top", scrollTop: 300, drift: -500, target: 0 },
    { name: "has nothing to move at the top", scrollTop: 0, drift: -20, target: null },
  ])("$name", ({ scrollTop, drift, target }) => {
    expect(readerLineScrollTop(geometry(scrollTop), drift)).toBe(target);
  });
});
