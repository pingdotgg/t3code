import { describe, expect, it } from "vite-plus/test";

import { isThreadSectionNameDuplicate } from "./ThreadSectionNameDialog";

describe("isThreadSectionNameDuplicate", () => {
  it("allows a case-only rename of the current section", () => {
    expect(
      isThreadSectionNameDuplicate({
        name: "review queue",
        initialName: "Review queue",
        existingNames: ["Review queue", "Later"],
      }),
    ).toBe(false);
  });

  it("rejects another existing section name case-insensitively", () => {
    expect(
      isThreadSectionNameDuplicate({
        name: "later",
        initialName: "Review queue",
        existingNames: ["Review queue", "Later"],
      }),
    ).toBe(true);
  });
});
