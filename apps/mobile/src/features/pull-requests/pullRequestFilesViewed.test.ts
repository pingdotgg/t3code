import { describe, expect, it } from "vite-plus/test";
import { viewedOverlay } from "./pullRequestFilesViewed";

describe("viewedOverlay", () => {
  it("keeps a press while its write is in flight", () => {
    expect(
      viewedOverlay({ "a.ts": { viewed: true, version: 1, awaitingReadAfter: undefined } }, 3),
    ).toEqual({ "a.ts": true });
  });

  it("yields a landed press to the next completed read, even one with unchanged data", () => {
    const presses = { "a.ts": { viewed: true, version: 1, awaitingReadAfter: 3 } };
    expect(viewedOverlay(presses, 3)).toEqual({ "a.ts": true });
    expect(viewedOverlay(presses, 4)).toEqual({});
  });
});
