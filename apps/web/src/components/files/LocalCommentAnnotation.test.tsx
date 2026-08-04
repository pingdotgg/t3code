import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { LocalCommentAnnotation } from "./LocalCommentAnnotation";

const callbacks = {
  onTextChange: vi.fn(),
  onCancel: vi.fn(),
  onComment: vi.fn(),
  onDelete: vi.fn(),
};

describe("LocalCommentAnnotation", () => {
  it("renders the draft composer directly in the selected diff", () => {
    const markup = renderToStaticMarkup(
      <LocalCommentAnnotation kind="draft" rangeLabel="+78" text="" {...callbacks} />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("font-mono");
    expect(markup).not.toContain("Local comment");
    expect(markup).not.toContain("on +78");
    expect(markup).toContain("⌘/Ctrl Enter to send");
    expect(markup).toContain("Add a comment…");
    expect(markup).toContain(">Comment</button>");
    expect(markup).toContain("autofocus");
    const textareaControl = markup.match(/<span[^>]*data-slot="textarea-control"[^>]*>/)?.[0];
    expect(textareaControl).toBeDefined();
    expect(textareaControl).not.toContain("ring-ring");
    expect(markup).toContain("cursor-text");
  });

  it("renders a saved comment without a nested card or redundant range label", () => {
    const markup = renderToStaticMarkup(
      <LocalCommentAnnotation
        kind="comment"
        rangeLabel="+78"
        text="Please keep this branch explicit."
        {...callbacks}
      />,
    );

    expect(markup).toContain("font-sans");
    expect(markup).not.toContain("chat-composer-glass");
    expect(markup).not.toContain("on +78");
    expect(markup).toContain("Please keep this branch explicit.");
    expect(markup).toContain('aria-label="Delete comment"');
    expect(markup).toContain("border-s-2");
    expect(markup).toContain("bg-primary/[0.045]");
    expect(markup).toContain("lucide-message-circle");
  });

  it("renders draft text owned by the annotation wrapper", () => {
    const markup = renderToStaticMarkup(
      <LocalCommentAnnotation
        kind="draft"
        rangeLabel="+78"
        text="Keep this unsaved draft"
        {...callbacks}
      />,
    );

    expect(markup).toContain("Keep this unsaved draft");
  });
});
