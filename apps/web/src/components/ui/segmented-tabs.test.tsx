import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SegmentedTab } from "./segmented-tabs";

describe("SegmentedTab", () => {
  it("composes the shared toggle with fixed button semantics", () => {
    const markup = renderToStaticMarkup(<SegmentedTab selected>Cost</SegmentedTab>);

    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("h-6");
  });

  it("uses the shared compact geometry", () => {
    const markup = renderToStaticMarkup(
      <SegmentedTab selected={false} density="compact">
        Summary
      </SegmentedTab>,
    );

    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("h-5");
  });
});
