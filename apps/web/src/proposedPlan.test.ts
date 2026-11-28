import { stripDisplayedPlanMarkdown } from "@t3tools/shared/proposedPlanText";
import { describe, expect, it } from "vite-plus/test";

import { buildCollapsedProposedPlanPreviewMarkdown } from "./proposedPlan";

describe("buildCollapsedProposedPlanPreviewMarkdown", () => {
  it.each(["node smoke-check.mjs", "[0]: <>"])(
    "keeps an exact-fit preview with %s in the code example",
    (example) => {
      const body = Array.from({ length: 7 }, (_, index) => `Step ${index + 1}`).join("\n");
      const plan = ["```sh", example, "```", "", "# Release plan", "", body].join("\n");
      const displayed = stripDisplayedPlanMarkdown(plan);
      expect(buildCollapsedProposedPlanPreviewMarkdown(plan, { maxLines: 10 })).toBe(displayed);
      expect(
        buildCollapsedProposedPlanPreviewMarkdown(`${plan}\nAnother step`, { maxLines: 10 }),
      ).toBe(`${displayed}\n\n...`);
    },
  );

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
