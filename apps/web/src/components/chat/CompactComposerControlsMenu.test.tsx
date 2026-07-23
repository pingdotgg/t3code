import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CompactComposerAccessControls } from "./CompactComposerControlsMenu";

describe("CompactComposerAccessControls", () => {
  it("shows Pi-managed tool access without a misleading runtime-mode selector", () => {
    const markup = renderToStaticMarkup(
      <CompactComposerAccessControls
        runtimeMode="full-access"
        showRuntimeModeSelector={false}
        toolAccessDescription="Pi manages enabled tool access; Pi tools can run without a T3 Code per-tool confirmation."
        onRuntimeModeChange={vi.fn()}
      />,
    );

    expect(markup).toContain("Pi-managed tools");
    expect(markup).toContain("Pi manages enabled tool access");
    expect(markup).not.toContain("Supervised");
    expect(markup).not.toContain("Auto-accept edits");
    expect(markup).not.toContain("Full access");
  });
});
