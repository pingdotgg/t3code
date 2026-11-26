import "~/index.css";

import { expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { RightPanelSheet } from "../components/RightPanelSheet";
import { BrowserSurfaceSlot } from "./BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";

it("presents a webview in the right panel sheet above the sheet", async () => {
  await using _screen = await render(
    <RightPanelSheet open animationDurationMs={0} onClose={() => {}}>
      <BrowserSurfaceSlot tabId="sheet-tab" visible className="h-40 w-40" />
    </RightPanelSheet>,
  );
  const sheet = document.querySelector('[data-slot="sheet-viewport"]');
  const sheetZIndex = Number(getComputedStyle(sheet!).zIndex);

  expect(sheetZIndex).toBe(46);
  expect(useBrowserSurfaceStore.getState().byTabId["sheet-tab"]?.zIndex).toBeGreaterThan(
    sheetZIndex,
  );
});
