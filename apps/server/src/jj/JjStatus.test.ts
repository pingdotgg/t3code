import { assert, describe, it } from "@effect/vitest";

import { refNameFromSegment } from "./JjStatus.ts";

describe("refNameFromSegment", () => {
  it("takes the lexicographically first name of the last bookmarked row", () => {
    assert.equal(
      refNameFromSegment([
        { commitId: "a", empty: true, localBookmarks: [] },
        { commitId: "b", empty: false, localBookmarks: ["zeta", "alpha"] },
      ]),
      "alpha",
    );
  });

  it("is null when nothing in the segment carries a bookmark", () => {
    assert.equal(refNameFromSegment([{ commitId: "a", empty: true, localBookmarks: [] }]), null);
  });
});
