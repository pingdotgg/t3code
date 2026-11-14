import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { RightPanelSheet } from "./RightPanelSheet";

it("names the open right-panel dialog", async () => {
  await using _screen = await render(
    <RightPanelSheet open animationDurationMs={0} onClose={() => {}}>
      <div>Panel content</div>
    </RightPanelSheet>,
  );
  const dialog = page.getByRole("dialog");
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).not.toHaveAccessibleName("");
});
