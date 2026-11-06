import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "./dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "./tooltip";

it("returns dialog focus without reopening the trigger tooltip, then allows Tab focus", async () => {
  await using screen = await render(
    <TooltipProvider>
      <Dialog>
        <Tooltip>
          <TooltipTrigger render={<DialogTrigger />}>Open dialog</TooltipTrigger>
          <TooltipPopup>Trigger help</TooltipPopup>
        </Tooltip>
        <DialogPopup>
          <DialogTitle>Example</DialogTitle>
          <button type="button">Inside dialog</button>
        </DialogPopup>
      </Dialog>
      <button type="button">Next</button>
    </TooltipProvider>,
  );
  await screen.getByRole("button", { name: "Open dialog" }).click();
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  expect(document.activeElement?.textContent).toBe("Open dialog");
  await vi.waitFor(() => expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull());
  await userEvent.keyboard("{Tab}{Shift>}{Tab}{/Shift}");
  await expect.element(page.getByText("Trigger help")).toBeVisible();
});

it.each([undefined, true])(
  "keeps outside input focus when a menu closes with finalFocus=%s",
  async (finalFocus) => {
    await using screen = await render(
      <>
        <Menu modal={false}>
          <MenuTrigger>Open menu</MenuTrigger>
          <MenuPopup finalFocus={finalFocus}>
            <MenuItem>Action</MenuItem>
          </MenuPopup>
        </Menu>
        <input aria-label="Outside input" />
      </>,
    );
    await screen.getByRole("button", { name: "Open menu" }).click();
    await expect.element(page.getByRole("menu")).toBeVisible();
    await screen.getByRole("textbox", { name: "Outside input" }).click();
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("textbox", { name: "Outside input" })).toHaveFocus();
  },
);
