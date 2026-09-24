import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Switch } from "./switch";

function renderSwitchRoot(props: Partial<Parameters<typeof Switch>[0]>) {
  const html = renderToStaticMarkup(<Switch aria-label="Enable Claude Code" {...props} />);
  return html.match(/<span[^>]*role="switch"[^>]*>/)?.[0] ?? "";
}

describe("Switch accessibility", () => {
  it("exposes the checked state to assistive tech", () => {
    expect(renderSwitchRoot({ checked: true })).toContain('aria-checked="true"');
    expect(renderSwitchRoot({ checked: false })).toContain('aria-checked="false"');
  });

  it("exposes the mixed state", () => {
    expect(renderSwitchRoot({ checked: false, mixed: true })).toContain('aria-checked="mixed"');
  });
});
