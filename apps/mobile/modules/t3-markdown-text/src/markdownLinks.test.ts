import { describe, expect, it } from "vite-plus/test";

import { resolveMarkdownLinkPresentation } from "./markdownLinks";

describe("resolveMarkdownLinkPresentation", () => {
  it("preserves valid Codex follow-up actions for the native press handler", () => {
    const href = "t3-followup:Explain%20why%20sunsets%20look%20red.";

    expect(resolveMarkdownLinkPresentation(href)).toEqual({ kind: "link", href });
  });

  it("does not preserve malformed Codex follow-up actions", () => {
    expect(resolveMarkdownLinkPresentation("t3-followup:%E0%A4%A")).toEqual({
      kind: "link",
      href: null,
    });
  });
});
