import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

function renderRightPanelControl(rightPanelAvailable: boolean): string {
  return renderToStaticMarkup(
    <PanelLayoutControls
      showTerminalControl={false}
      terminalAvailable={false}
      terminalOpen={false}
      terminalShortcutLabel={null}
      rightPanelAvailable={rightPanelAvailable}
      rightPanelOpen={false}
      rightPanelShortcutLabel={null}
      liveAgentCount={0}
      onToggleTerminal={() => undefined}
      onToggleRightPanel={() => undefined}
    />,
  );
}

describe("PanelLayoutControls", () => {
  it("keeps the disabled right-panel glyph the same size as the enabled glyph", () => {
    const enabled = renderRightPanelControl(true);
    const disabled = renderRightPanelControl(false);

    expect(enabled).toMatch(/lucide-panel-right[^>]*size-3\.5/);
    expect(disabled).toMatch(/lucide-panel-right[^>]*size-3\.5/);
    expect(disabled).toContain("text-muted-foreground opacity-100");
    expect(disabled).toContain("disabled");
  });
});
