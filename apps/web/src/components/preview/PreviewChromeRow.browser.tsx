import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PreviewChromeRow } from "./PreviewChromeRow";

async function mountChrome() {
  return await render(
    <PreviewChromeRow
      url="https://example.com/dashboard"
      loading={false}
      loadProgress={0}
      canGoBack
      canGoForward
      refreshDisabled={false}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onRefresh={vi.fn()}
      onSubmit={vi.fn()}
      onCapture={vi.fn()}
    />,
  );
}

describe("PreviewChromeRow", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("lays the toolbar out as a single row", async () => {
    const screen = await mountChrome();
    try {
      const row = document.querySelector<HTMLElement>("[data-surface-subheader]")!;
      // `.surface-subheader` must exist in the stylesheet: without it the row
      // has no flex context and the address bar stacks under the nav buttons.
      expect(getComputedStyle(row).display).toBe("flex");

      const back = await page.getByLabelText("Back").element();
      const input = await page.getByPlaceholder("Search or enter URL").element();
      const backRect = back.getBoundingClientRect();
      const inputRect = input.getBoundingClientRect();

      // Address bar sits beside the nav buttons, sharing their vertical band.
      expect(inputRect.left).toBeGreaterThan(backRect.left);
      expect(inputRect.top).toBeLessThan(backRect.bottom);
      expect(inputRect.bottom).toBeGreaterThan(backRect.top);
      expect(row.getBoundingClientRect().height).toBe(32);
      expect(inputRect.height).toBeLessThanOrEqual(24);
      expect(document.querySelector("[data-preview-chrome-actions]")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
