import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Menu, MenuCheckboxItem } from "./menu";
import { Switch } from "./switch";

describe("switch colors", () => {
  it("keeps the unchecked track visible when a theme has a transparent input border", () => {
    const html = renderToStaticMarkup(<Switch checked={false} aria-label="Example" />);

    expect(html).toContain("data-unchecked:bg-muted-foreground/30");
    expect(html).not.toContain("data-unchecked:bg-input");
  });

  it("uses the same visible unchecked track in switch menu items", () => {
    const html = renderToStaticMarkup(
      <Menu open>
        <MenuCheckboxItem checked={false} variant="switch">
          Example
        </MenuCheckboxItem>
      </Menu>,
    );

    expect(html).toContain("data-unchecked:bg-muted-foreground/30");
    expect(html).not.toContain("data-unchecked:bg-input");
  });
});
