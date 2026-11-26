import { expect, it } from "vite-plus/test";

import { buildProposedPlanMarkdownFilename } from "./proposedPlan";

it("names a downloaded plan after the first nonempty Markdown heading", () => {
  const markdown = "## ###\n\n## Release checklist\n\nUpdate the notes.";
  expect(buildProposedPlanMarkdownFilename(markdown)).toBe("release-checklist.md");
});
