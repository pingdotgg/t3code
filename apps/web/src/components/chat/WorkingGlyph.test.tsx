import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkingGlyph } from "./WorkingGlyph";

describe("WorkingGlyph", () => {
  it("draws three dots on a ring with a tail and hides itself from assistive tech", () => {
    const markup = renderToStaticMarkup(<WorkingGlyph />);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("working-glyph-ring");
    expect(markup).toContain("working-glyph-core");
    // The descending opacities are the tail. Without them the stepped rotation
    // is invisible, because three identical dots 120 degrees apart look the
    // same at every step.
    expect(markup).toContain('opacity="0.55"');
    expect(markup).toContain('opacity="0.28"');
  });

  it("does not fall back to the generic status pulse", () => {
    // The point of the glyph is that the one surface the user is actually
    // waiting on stops sharing the blink every other live indicator uses.
    expect(renderToStaticMarkup(<WorkingGlyph />)).not.toContain("animate-status-pulse");
  });
});
