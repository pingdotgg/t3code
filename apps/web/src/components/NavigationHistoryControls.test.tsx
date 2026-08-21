import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

import { NavigationHistoryButtons } from "./NavigationHistoryControls";

it("exposes named back and forward buttons with independent disabled states", () => {
  const markup = renderToStaticMarkup(
    <NavigationHistoryButtons
      backShortcut="⌘["
      canGoBack={false}
      canGoForward
      forwardShortcut="⌘]"
      onBack={vi.fn()}
      onForward={vi.fn()}
    />,
  );

  expect(markup).toMatch(/aria-disabled="true" aria-label="Back"/);
  expect(markup).toMatch(/aria-disabled="false" aria-label="Forward"/);
  expect(markup).toContain('aria-label="Navigation history"');
});
