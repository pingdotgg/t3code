import type { PreviewAnnotationPayload } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPreviewAnnotationCards } from "./ComposerPreviewAnnotationCards";

const annotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000/welcome",
  pageTitle: "Welcome",
  comment: "Make this headline feel intentional.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 1, y: 2, width: 30, height: 20 } }],
  strokes: [],
  styleChanges: [
    {
      targetId: "element_1",
      selector: "h1",
      property: "font-size",
      previousValue: "32px",
      value: "40px",
    },
  ],
  screenshot: null,
  createdAt: "2026-06-13T00:00:00.000Z",
};

describe("ComposerPreviewAnnotationCards", () => {
  it("presents the annotation as one contextual attachment", () => {
    const markup = renderToStaticMarkup(
      <ComposerPreviewAnnotationCards
        annotations={[annotation]}
        images={[]}
        onRemove={vi.fn()}
        onExpandImage={vi.fn()}
      />,
    );

    expect(markup).toContain("Make this headline feel intentional.");
    expect(markup).toContain('title="1 region"');
    expect(markup).toContain('title="1 style change"');
    expect(markup).not.toContain("Welcome");
    expect(markup).not.toContain("localhost:3000");
    expect(markup).not.toContain("Preview annotation");
  });
});
