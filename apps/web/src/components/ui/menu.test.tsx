import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { hasExplicitWidthClass, Menu, MenuRadioGroup, MenuRadioItem } from "./menu";

describe("menu radio item geometry", () => {
  it("keeps radio-item icons on the same text grid as menu items", () => {
    const html = renderToStaticMarkup(
      <Menu>
        <MenuRadioGroup value="merge">
          <MenuRadioItem value="merge">
            <span className="flex items-center gap-2">
              <svg aria-hidden className="size-3.5" />
              <span>Merge</span>
            </span>
          </MenuRadioItem>
        </MenuRadioGroup>
      </Menu>,
    );

    expect(html).toContain("-mx-0.5");
  });
});

describe("menu popup width classes", () => {
  it("grows the sidebar project dropdown with the longest project name instead of pinning to the trigger width", () => {
    // Sidebar passes this to MenuPopup so the "All projects" scope dropdown
    // can widen past the trigger while staying inside the viewport.
    const className = "min-w-(--anchor-width) max-w-[min(600px,var(--available-width))]";

    expect(hasExplicitWidthClass(className)).toBe(true);
    // Any explicit width utility, not just the ones above, suppresses the
    // default min-w-32 fallback that otherwise pins popups to their trigger.
    expect(hasExplicitWidthClass("w-(--anchor-width)")).toBe(true);
    expect(hasExplicitWidthClass("min-w-32")).toBe(true);
    expect(hasExplicitWidthClass("flex items-center gap-2")).toBe(false);
    expect(hasExplicitWidthClass(undefined)).toBe(false);
  });
});
