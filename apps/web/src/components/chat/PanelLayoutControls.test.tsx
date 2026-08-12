import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

function renderControls(options?: {
  sourceControlAvailable?: boolean;
  sourceControlOpen?: boolean;
  rightPanelOpen?: boolean;
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
      rightPanelOpen={options?.rightPanelOpen ?? false}
      rightPanelShortcutLabel="Ctrl+Shift+B"
      liveAgentCount={0}
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

  it("shows source control and the standard right panel as open at the same time", () => {
    const markup = renderControls({ sourceControlOpen: true, rightPanelOpen: true });

    expect(markup).toMatch(/aria-label="Toggle source control"[^>]*data-pressed/);
    expect(markup).toMatch(/aria-label="Toggle right panel"[^>]*data-pressed/);
  });

  it("keeps source control as the rightmost layout control", () => {
    const markup = renderControls();

    expect(markup.indexOf('aria-label="Toggle terminal drawer"')).toBeLessThan(
      markup.indexOf('aria-label="Toggle right panel"'),
    );
    expect(markup.indexOf('aria-label="Toggle right panel"')).toBeLessThan(
      markup.indexOf('aria-label="Toggle source control"'),
    );
  });
});
