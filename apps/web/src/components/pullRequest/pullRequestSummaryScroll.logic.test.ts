import { describe, expect, it } from "vite-plus/test";

import { sectionCollapseAnchorScrollTop } from "./pullRequestSummaryScroll.logic";

describe("section collapse scroll anchoring", () => {
  it("returns the section's natural offset when its heading is pinned", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 600,
        viewportTop: 264,
        sectionTop: -200,
        headingTop: 264,
      }),
    ).toBe(136);
  });

  it("allows a fractional sticky-edge difference", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 500,
        viewportTop: 264,
        sectionTop: 100,
        headingTop: 264.5,
      }),
    ).toBe(336);
  });

  it("leaves the scroll position alone before the heading becomes sticky", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 120,
        viewportTop: 264,
        sectionTop: 320,
        headingTop: 320,
      }),
    ).toBeNull();
  });

  it("does not produce a negative scroll offset", () => {
    expect(
      sectionCollapseAnchorScrollTop({
        scrollTop: 20,
        viewportTop: 264,
        sectionTop: 200,
        headingTop: 264,
      }),
    ).toBe(0);
  });
});
