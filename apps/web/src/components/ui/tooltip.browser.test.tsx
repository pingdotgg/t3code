import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
