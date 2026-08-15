import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Menu, MenuRadioGroup, MenuRadioItem } from "./menu";

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
