import { describe, expect, it } from "vite-plus/test";

import { buildCollapsedProposedPlanPreview } from "./proposedPlan";
import {
  createAssistantTextSelector,
  findAssistantCitationText,
} from "./lib/assistantTextSelection";

describe("proposed plan preview citations", () => {
  it("resolves repeated text at the preview boundary after expansion", () => {
    const quote = "Repeatable health check.";
    const planMarkdown = `Check remote.\n${quote}\nExtended acceptance.\n${quote}`;
    const { markdown: preview } = buildCollapsedProposedPlanPreview(planMarkdown, { maxLines: 2 });
    const start = preview.indexOf(quote);
    const citation = createAssistantTextSelector(preview, start, start + quote.length)!;

    expect(findAssistantCitationText(planMarkdown, citation)).toEqual({
      start,
      end: start + quote.length,
    });
  });
});
