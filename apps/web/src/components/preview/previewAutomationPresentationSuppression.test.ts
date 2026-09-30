import { describe, expect, it } from "vite-plus/test";

import {
  isPreviewAutomationPresentationSuppressed,
  prunePreviewAutomationPresentationSuppressions,
  setPreviewAutomationPresentationSuppressed,
  type PreviewAutomationPresentationSuppressions,
} from "./previewAutomationPresentationSuppression";

describe("preview automation presentation suppression", () => {
  it("records and clears suppression without retaining empty thread entries", () => {
    const suppressions: PreviewAutomationPresentationSuppressions = new Map();

    setPreviewAutomationPresentationSuppressed(
      suppressions,
      "environment:thread",
      "runtime-1",
      true,
    );
    expect(
      isPreviewAutomationPresentationSuppressed(suppressions, "environment:thread", "runtime-1"),
    ).toBe(true);

    setPreviewAutomationPresentationSuppressed(
      suppressions,
      "environment:thread",
      "runtime-1",
      false,
    );
    expect(suppressions.size).toBe(0);
  });

  it("prunes runtime identities replaced by server reconciliation", () => {
    const suppressions: PreviewAutomationPresentationSuppressions = new Map([
      ["environment:thread", new Set(["stale-runtime", "current-runtime"])],
    ]);

    prunePreviewAutomationPresentationSuppressions(
      suppressions,
      "environment:thread",
      new Set(["current-runtime"]),
    );

    expect(suppressions.get("environment:thread")).toEqual(new Set(["current-runtime"]));
  });

  it("removes the thread entry when reconciliation leaves no suppressed runtime", () => {
    const suppressions: PreviewAutomationPresentationSuppressions = new Map([
      ["environment:thread", new Set(["stale-runtime"])],
    ]);

    prunePreviewAutomationPresentationSuppressions(suppressions, "environment:thread", new Set());

    expect(suppressions.size).toBe(0);
  });
});
