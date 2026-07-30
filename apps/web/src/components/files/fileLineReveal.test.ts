import { describe, expect, it } from "vite-plus/test";

import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";

describe("resolveCenteredFileLineScrollTop", () => {
  it("centers an estimated virtualized line position", () => {
    expect(
      resolveCenteredFileLineScrollTop({
        scrollTop: 0,
        scrollHeight: 2_000,
        viewportTop: 100,
        viewportHeight: 400,
        fileTop: 20,
        estimatedLine: { top: 1_000, height: 20 },
      }),
    ).toBe(830);
  });

  it("corrects a stale estimate from the rendered line geometry", () => {
    expect(
      resolveCenteredFileLineScrollTop({
        scrollTop: 830,
        scrollHeight: 2_000,
        viewportTop: 100,
        viewportHeight: 400,
        fileTop: 20,
        estimatedLine: { top: 1_000, height: 20 },
        renderedLine: { top: 620, height: 20 },
      }),
    ).toBe(1_160);
  });
});
