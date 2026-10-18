import "~/index.css";

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { ComposerSurface } from "./ComposerSurface";

it("masks the toolbar overlap and reveals its surface one pixel before the input edge", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <ComposerSurface.Shell contextStrip>
          <ComposerSurface.Host>Message</ComposerSurface.Host>
          <ComposerSurface.ContextStrip>Workspace</ComposerSurface.ContextStrip>
        </ComposerSurface.Shell>,
      );
    });

    const strip = container.querySelector('[data-slot="composer-context-strip"]')!;
    const mask = getComputedStyle(strip, "::before").maskImage;
    expect(mask).toContain("rgba(0, 0, 0, 0) 15px, rgb(0, 0, 0) 15px");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
