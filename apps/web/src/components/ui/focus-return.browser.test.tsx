import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "./dialog";
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
