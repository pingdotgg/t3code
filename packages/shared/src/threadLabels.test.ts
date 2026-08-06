import { describe, expect, it } from "vite-plus/test";

import { THREAD_LABEL_OPTIONS, threadLabelDisplayName } from "./threadLabels.ts";

describe("thread labels", () => {
  it("includes New Build in the shared label options", () => {
    expect(THREAD_LABEL_OPTIONS).toContainEqual({ value: "new-build", label: "New Build" });
    expect(threadLabelDisplayName("new-build")).toBe("New Build");
  });
});
