import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { DiffCommentAnnotation } from "./DiffCommentAnnotation";

const callbacks = {
  onTextChange: vi.fn(),
  onCancel: vi.fn(),
  onComment: vi.fn(),
  onDelete: vi.fn(),
};

describe("DiffCommentAnnotation", () => {
  it("lets a pull-request diff configure actions without replacing the composer", () => {
    const markup = renderToStaticMarkup(
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="src/app.ts:4"
        text=""
        {...callbacks}
        submitLabel="Add to review"
        secondaryAction={{
          label: "Add to agent",
          onAction: vi.fn(),
        }}
      />,
    );

    expect(markup).toContain("Add a comment…");
    expect(markup).toContain(">Add to review</button>");
    expect(markup.match(/<button[^>]*disabled[^>]*>Add to review<\/button>/)).not.toBeNull();
    expect(markup.match(/<button[^>]*disabled[^>]*>Add to agent<\/button>/)).not.toBeNull();
  });
});
