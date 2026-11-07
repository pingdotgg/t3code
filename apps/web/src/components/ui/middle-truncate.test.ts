import { describe, expect, it } from "vite-plus/test";

import { splitForMiddleTruncate } from "./middle-truncate";

describe("splitForMiddleTruncate", () => {
  it("keeps a short last path segment whole", () => {
    expect(splitForMiddleTruncate("feature/ui-polish")).toEqual({
      head: "feature/",
      tail: "ui-polish",
    });
  });

  it("starts a long segment's tail on a word, not mid-word", () => {
    expect(splitForMiddleTruncate("t3/clone-repo-to-other-machine")?.tail).toBe("machine");
    expect(splitForMiddleTruncate("t3/investigate-release-build-times")?.tail).toBe("times");
  });

  it("falls back to an earlier word when the last one is too short", () => {
    expect(splitForMiddleTruncate("t3/compare-long-featurenames-ab")?.tail).toBe("featurenames-ab");
  });

  it("keeps the fixed tail when no word break is near", () => {
    expect(splitForMiddleTruncate("t3/abcdefghijklmnopqrstuvwxyz")?.tail).toBe("qrstuvwxyz");
  });

  it("starts a title's tail on a word", () => {
    expect(splitForMiddleTruncate("Debate Weaknesses in Bilateral Agreements")).toEqual({
      head: "Debate Weaknesses in Bilateral ",
      tail: "Agreements",
    });
  });

  it("flattens line breaks so a value stays on one line", () => {
    expect(splitForMiddleTruncate("first\nsecond line of a label")?.head).not.toContain("\n");
  });

  it("respects an explicit tail length", () => {
    expect(splitForMiddleTruncate("t3/clone-repo-to-other-machine", 6)?.tail).toBe("achine");
  });
});
