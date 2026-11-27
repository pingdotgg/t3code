import { describe, expect, it } from "vite-plus/test";

import { buildCollapsedProposedPlanPreviewMarkdown } from "./proposedPlan";

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  it("closes a code block the preview cuts through, so the ellipsis stays outside it", () => {
    const plan = [
      "# Plan",
      "",
      "```ts",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "```",
      "",
      "Done.",
    ].join("\n");
    expect(buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 3 })).toBe(
      ["```ts", "const a = 1;", "const b = 2;", "```", "", "..."].join("\n"),
    );
  });

  it("leaves a code block that ends inside the preview alone", () => {
    const plan = ["~~~~", "```", "~~~~", "", "Next", "More"].join("\n");
    expect(buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 4 })).toBe(
      ["~~~~", "```", "~~~~", "", "Next", "", "..."].join("\n"),
    );
  });
});
