import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Switch } from "./switch";

describe("switch colors", () => {
  it("keeps the unchecked track visible when a theme has a transparent input border", () => {
    const html = renderToStaticMarkup(<Switch checked={false} aria-label="Example" />);

    expect(html).toContain("data-unchecked:bg-muted-foreground/30");
    expect(html).not.toContain("data-unchecked:bg-input");
  });
});
