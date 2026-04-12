import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DesktopChromeOverlay } from "./DesktopChromeOverlay";

describe("DesktopChromeOverlay", () => {
  it("renders both control banks as separate minimal fixed roots", () => {
    const markup = renderToStaticMarkup(
      <DesktopChromeOverlay
        layout={{
          left: ["minimize"],
          right: ["close"],
        }}
      />,
    );

    expect(markup).toContain("fixed left-3 top-0 z-50");
    expect(markup).toContain("fixed right-3 top-0 z-50");
    expect(markup).not.toContain("drag-region");
    expect(markup).toContain('aria-label="minimize"');
    expect(markup).toContain('aria-label="close"');
  });
});
