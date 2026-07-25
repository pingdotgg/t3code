import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("PanelLayoutControls", () => {
  it("places the whole-panel close control at the right edge", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        terminalAvailable
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen
        rightPanelShortcutLabel={null}
        onToggleTerminal={vi.fn()}
        onToggleRightPanel={vi.fn()}
        onCloseRightPanel={vi.fn()}
      />,
    );

    expect(markup.indexOf('aria-label="Close right panel"')).toBeGreaterThan(
      markup.indexOf('aria-label="Toggle right panel"'),
    );
  });
});
