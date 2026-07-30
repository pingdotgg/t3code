import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerInteractionModePill } from "./ComposerInteractionModePill";
import { composerInteractionModeConfig } from "./composerInteractionMode";

describe("ComposerInteractionModePill", () => {
  it.each([
    ["default", "Build", "sky"],
    ["ask", "Ask", "emerald"],
    ["plan", "Plan", "amber"],
  ] as const)("renders the %s Forma treatment", (mode, label, color) => {
    const markup = renderToStaticMarkup(<ComposerInteractionModePill interactionMode={mode} />);
    expect(markup).toContain(`data-composer-interaction-mode-pill="${mode}"`);
    expect(markup).toContain(`>${label}<`);
    expect(composerInteractionModeConfig[mode].pillClassName).toContain(color);
  });
});
