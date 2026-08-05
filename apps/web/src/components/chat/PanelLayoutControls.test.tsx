import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

function renderControls(options?: {
  sourceControlAvailable?: boolean;
  sourceControlOpen?: boolean;
}) {
  return renderToStaticMarkup(
    <PanelLayoutControls
      terminalAvailable
      terminalOpen={false}
      terminalShortcutLabel="Ctrl+J"
      sourceControlAvailable={options?.sourceControlAvailable ?? true}
      sourceControlOpen={options?.sourceControlOpen ?? false}
      sourceControlShortcutLabel="Ctrl+Shift+G"
      rightPanelAvailable
      rightPanelOpen={false}
      rightPanelShortcutLabel="Ctrl+Shift+B"
      onToggleTerminal={() => {}}
      onToggleSourceControl={() => {}}
      onToggleRightPanel={() => {}}
    />,
  );
}

describe("PanelLayoutControls", () => {
  it("gives source control a dedicated toggle with its own pressed state", () => {
    const markup = renderControls({ sourceControlOpen: true });

    expect(markup).toContain('aria-label="Toggle source control"');
    expect(markup).toMatch(/aria-label="Toggle source control"[^>]*data-pressed/);
    expect(markup).toContain("lucide-git-branch");
  });

  it("disables the source control toggle outside a git repository", () => {
    const markup = renderControls({ sourceControlAvailable: false });

    expect(markup).toMatch(/aria-label="Toggle source control"[^>]*disabled/);
  });
});
