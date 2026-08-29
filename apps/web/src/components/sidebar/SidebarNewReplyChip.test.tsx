import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SidebarNewReplyChip } from "./SidebarNewReplyChip";

describe("SidebarNewReplyChip", () => {
  it("renders a persistent labeled success chip", () => {
    const markup = renderToStaticMarkup(<SidebarNewReplyChip />);

    expect(markup).toContain('aria-label="New reply"');
    expect(markup).toContain('data-testid="sidebar-new-reply-chip"');
    expect(markup).toContain("bg-success/8");
    expect(markup).toContain("New reply");
  });
});
