import { describe, expect, it } from "vite-plus/test";

import { isComposerInputDisabled } from "./composerInputAvailability";

describe("isComposerInputDisabled", () => {
  it("keeps drafting available while the environment or provider connects", () => {
    expect(
      isComposerInputDisabled({
        approvalActive: false,
        projectSelectionRequired: false,
      }),
    ).toBe(false);
  });

  it("disables drafting only when the composer is serving another required interaction", () => {
    expect(
      isComposerInputDisabled({
        approvalActive: true,
        projectSelectionRequired: false,
      }),
    ).toBe(true);
    expect(
      isComposerInputDisabled({
        approvalActive: false,
        projectSelectionRequired: true,
      }),
    ).toBe(true);
  });
});
