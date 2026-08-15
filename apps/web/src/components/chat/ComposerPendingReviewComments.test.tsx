import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";

describe("ComposerPendingReviewComments", () => {
  it("keeps an empty-note chip visible without an empty tooltip", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingReviewComments
        comments={[
          {
            id: "selection-1",
            sectionId: "pull-request:42",
            sectionTitle: "PR #42",
            filePath: "src/app.ts",
            startIndex: 3,
            endIndex: 5,
            rangeLabel: "L4-L6",
            text: "",
            diff: "+const answer = 42;",
          },
        ]}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain("src/app.ts L4-L6");
    expect(markup).not.toContain('data-slot="tooltip-trigger"');
  });
});
