import type { PullRequestFilesViewedResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { viewedOverlay } from "./pullRequestFilesViewed";

// The overlay compares reads by identity, so each call is a distinct read.
const read = (): PullRequestFilesViewedResult => ({ files: [], truncated: false });

describe("viewedOverlay", () => {
  it("keeps a press while its write is in flight", () => {
    const before = read();
    expect(
      viewedOverlay({ "a.ts": { viewed: true, version: 1, awaitingReadAfter: undefined } }, before),
    ).toEqual({ "a.ts": true });
  });

  it("keeps a landed press until a read newer than the one current at the write", () => {
    const before = read();
    const presses = {
      "a.ts": { viewed: true, version: 1, awaitingReadAfter: { read: before } },
    };
    expect(viewedOverlay(presses, before)).toEqual({ "a.ts": true });
    expect(viewedOverlay(presses, read())).toEqual({});
  });
});
