import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "@effect/vitest";

import { SidebarHomeButton } from "./Sidebar";

describe("SidebarHomeButton", () => {
  it("renders the app wordmark as a button without an href for VS Code webviews", () => {
    const html = renderToStaticMarkup(<SidebarHomeButton aria-label="Go to threads" />);

    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
  });
});
