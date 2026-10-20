import { expect, it } from "vite-plus/test";

import { act, render as renderUi } from "../../../test/render";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { ThreadDetailsControl } from "./ThreadDetailsControl";

it("keeps the row label and one chevron when used as a menu trigger", async () => {
  await using screen = await renderUi(
    <Menu>
      <MenuTrigger render={<ThreadDetailsControl part="select" />}>Run on this machine</MenuTrigger>
      <MenuPopup>
        <MenuItem>New worktree</MenuItem>
      </MenuPopup>
    </Menu>,
  );
  const { container } = screen;
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toBe("Run on this machine");
  expect(trigger.querySelectorAll(".lucide-chevron-down")).toHaveLength(1);
  await act(async () => trigger.click());
  expect(document.querySelector('[role="menuitem"]')?.textContent).toBe("New worktree");
});
