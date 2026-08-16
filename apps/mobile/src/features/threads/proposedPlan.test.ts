import { describe, expect, it } from "vite-plus/test";

import {
  buildCollapsedProposedPlanPreviewMarkdown,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from "./proposedPlan";

describe("mobile proposed-plan presentation", () => {
  it("separates the title from the displayed plan body", () => {
    const markdown = "# Update Index Greeting\n\n## Summary\n\nReplace the old content.";

    expect(proposedPlanTitle(markdown)).toBe("Update Index Greeting");
    expect(stripDisplayedPlanMarkdown(markdown)).toBe("Replace the old content.");
  });

  it("falls back when the plan has no heading", () => {
    expect(proposedPlanTitle("- inspect\n- update")).toBeNull();
  });

  it("preserves a non-summary heading in the displayed body", () => {
    expect(
      stripDisplayedPlanMarkdown("# Update Index Greeting\n\n## Scope\n\n- Update the page."),
    ).toBe("## Scope\n\n- Update the page.");
  });

  it("builds a bounded preview for long plans", () => {
    expect(
      buildCollapsedProposedPlanPreviewMarkdown(
        "# Update Index Greeting\n\n- inspect\n- update\n- verify",
        { maxLines: 2 },
      ),
    ).toBe("- inspect\n- update\n\n...");
  });
});
