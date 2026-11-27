import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { Sheet, SheetPopup } from "~/components/ui/sheet";
import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

it("presents a webview in the right panel sheet above the sheet, and its overlays above the webview", async () => {
  const onFind = vi.fn();
  const onClose = vi.fn();
  await using _screen = await render(
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPopup transitionDurationMs={0} side="right" showCloseButton={false} keepMounted>
        <BrowserSurfaceSlot tabId="sheet-tab" visible className="h-40 w-40">
          <button type="button" className="pointer-events-auto" onClick={onFind}>
            Find in page
          </button>
        </BrowserSurfaceSlot>
      </SheetPopup>
    </Sheet>,
  );
  const sheet = document.querySelector('[data-slot="sheet-viewport"]');
  const sheetZIndex = Number(getComputedStyle(sheet!).zIndex);
  const webviewZIndex = useBrowserSurfaceStore.getState().byTabId["sheet-tab"]?.zIndex ?? 0;

  expect(sheetZIndex).toBe(46);
  expect(webviewZIndex).toBeGreaterThan(sheetZIndex);

  const find = page.getByRole("button", { name: "Find in page" });
  await expect.element(find).toBeVisible();
  const layer = find.element().closest<HTMLElement>("[data-browser-surface-overlay]");
  expect(Number(layer && getComputedStyle(layer).zIndex)).toBeGreaterThan(webviewZIndex);

  await find.click();
  expect(onFind).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});

it("keeps overlays in place for an inline slot", async () => {
  await using _screen = await render(
    <div data-testid="panel">
      <BrowserSurfaceSlot tabId="inline-tab" visible className="h-40 w-40">
        <button type="button">Find in page</button>
      </BrowserSurfaceSlot>
    </div>,
  );
  const find = page.getByRole("button", { name: "Find in page" });
  await expect.element(find).toBeVisible();
  expect(find.element().closest('[data-testid="panel"]')).not.toBeNull();
  expect(useBrowserSurfaceStore.getState().byTabId["inline-tab"]?.zIndex).toBe(30);
});
