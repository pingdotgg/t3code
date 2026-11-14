import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "./tooltip";

it.each([
  { focus: "mouse", keptOpen: false },
  { focus: "keyboard", keptOpen: true },
])("scrolling with a $focus-focused hovered trigger keeps it open: $keptOpen", async (c) => {
  const onScroll = vi.fn();
  await using screen = await render(
    <TooltipScrollDismissArea
      data-testid="timeline"
      onScrollCapture={onScroll}
      className="h-32 overflow-y-auto"
    >
      <Tooltip>
        <TooltipTrigger>Timeline action</TooltipTrigger>
        <TooltipPopup>Description</TooltipPopup>
      </Tooltip>
      <div className="h-96" />
    </TooltipScrollDismissArea>,
  );
  const trigger = screen.getByRole("button", { name: "Timeline action" });
  if (c.focus === "mouse") {
    // A press closes the tooltip; hovering again reopens it with mouse focus kept.
    await userEvent.click(trigger);
    await userEvent.unhover(trigger);
  } else {
    await userEvent.keyboard("{Tab}");
  }
  await userEvent.hover(trigger);
  await expect.element(trigger).toHaveFocus();
  await expect.element(page.getByText("Description")).toBeVisible();

  screen.getByTestId("timeline").element().scrollTop = 20;
  await vi.waitFor(() => expect(onScroll).toHaveBeenCalledOnce());

  if (c.keptOpen) await expect.element(page.getByText("Description")).toBeVisible();
  else await expect.element(page.getByText("Description")).not.toBeInTheDocument();
});

it("stays open while the pointer selects its text, then closes when the pointer leaves", async () => {
  await using screen = await render(
    <Tooltip>
      <TooltipTrigger>File</TooltipTrigger>
      <TooltipPopup>/tmp/project/docs/notes.md</TooltipPopup>
    </Tooltip>,
  );
  await userEvent.hover(screen.getByRole("button", { name: "File" }));
  const text = page.getByText("/tmp/project/docs/notes.md");
  await expect.element(text).toBeVisible();

  // Forced so the pointer lands on the popup even when it ignores pointer events.
  await userEvent.tripleClick(text, { force: true });
  expect(window.getSelection()?.toString().trim()).toBe("/tmp/project/docs/notes.md");
  await expect.element(text).toBeVisible();

  await commands.resetPointer();
  await expect.element(text).not.toBeInTheDocument();
});

it("stays open when its own content scrolls inside a scroll dismiss area", async () => {
  await using screen = await render(
    <TooltipScrollDismissArea data-testid="timeline" className="h-32 overflow-y-auto">
      <Tooltip>
        <TooltipTrigger>Pull requests</TooltipTrigger>
        <TooltipPopup>
          <div data-testid="list" className="max-h-10 overflow-y-auto">
            <div className="h-40">Pull request list</div>
          </div>
        </TooltipPopup>
      </Tooltip>
      <div className="h-96" />
    </TooltipScrollDismissArea>,
  );
  const trigger = screen.getByRole("button", { name: "Pull requests" });
  await userEvent.hover(trigger);
  const list = page.getByTestId("list");
  await expect.element(list).toBeVisible();

  const listElement = list.element();
  const listScrolled = new Promise((resolve) =>
    listElement.addEventListener("scroll", resolve, { once: true }),
  );
  listElement.scrollTop = 20;
  await listScrolled;
  await expect.element(trigger).toHaveAttribute("data-popup-open");

  screen.getByTestId("timeline").element().scrollTop = 20;
  await expect.element(list).not.toBeInTheDocument();
});
