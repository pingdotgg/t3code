import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { createWorkspaceFocusController } from "../../lib/workspaceFocus";
import { SettingResetButton } from "./settingsLayout";

function ResettableRow() {
  const [customized, setCustomized] = useState(true);
  return (
    <div data-testid="scroller" style={{ height: 120, overflowY: "auto" }}>
      <button type="button">Close</button>
      <div style={{ height: 400 }} />
      <div data-testid="row" tabIndex={-1}>
        {customized ? (
          <SettingResetButton label="contrast" onClick={() => setCustomized(false)} />
        ) : null}
      </div>
      <div style={{ height: 400 }} />
      <div contentEditable aria-label="Font preview" />
    </div>
  );
}

it("keeps focus and scroll on the row when its reset button unmounts", async () => {
  const controller = createWorkspaceFocusController(document);
  using _controller = { [Symbol.dispose]: () => controller.dispose() };
  await using screen = await render(
    <section data-workspace-area="settings" tabIndex={-1}>
      <ResettableRow />
    </section>,
  );
  const scroller = screen.getByTestId("scroller").element();
  const reset = screen.getByRole("button", { name: "Reset contrast to default" });
  reset.element().scrollIntoView({ block: "center" });
  const scrollTop = scroller.scrollTop;
  expect(scrollTop).toBeGreaterThan(0);

  await reset.click();

  await expect.element(reset).not.toBeInTheDocument();
  await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("row").element()));
  expect(scroller.scrollTop).toBe(scrollTop);
});
