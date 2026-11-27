import { describe, expect, it } from "vite-plus/test";

import { buildCollapsedProposedPlanPreviewMarkdown } from "./proposedPlan";

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  it("closes a code block the preview cuts through, so the ellipsis stays outside it", () => {
    const plan = [
      "- Step",
      "  ```ts",
      "  const a = 1;",
      "  const b = 2;",
      "  ```",
      "",
      "Done.",
    ].join("\n");
    expect(buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 3 })).toBe(
      ["- Step", "  ```ts", "  const a = 1;", "  ```", "", "..."].join("\n"),
    );
  });

  it("adds no fence when every code block ends inside the preview, inline code included", () => {
    const plan = ["~~~~", "```", "~~~~", "", "```npm i```", "Next", "More"].join("\n");
    expect(buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 5 })).toBe(
      ["~~~~", "```", "~~~~", "", "```npm i```", "Next", "", "..."].join("\n"),
    );
  });
});
