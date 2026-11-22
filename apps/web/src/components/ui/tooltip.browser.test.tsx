import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SharedTooltipProvider, SharedTooltipTrigger } from "./shared-tooltip";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "./tooltip";

function TimelineAction({ shared }: { shared: boolean }) {
  if (shared) {
    return (
      <SharedTooltipProvider>
        <SharedTooltipTrigger label="Description" render={<button type="button" />}>
          Timeline action
        </SharedTooltipTrigger>
      </SharedTooltipProvider>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger>Timeline action</TooltipTrigger>
      <TooltipPopup>Description</TooltipPopup>
    </Tooltip>
  );
}

it.each([
  { shared: false, focus: "mouse", keptOpen: false },
  { shared: false, focus: "keyboard", keptOpen: true },
  { shared: true, focus: "mouse", keptOpen: false },
  { shared: true, focus: "keyboard", keptOpen: true },
])(
  "scrolling with a $focus-focused hovered trigger (shared: $shared) keeps it open: $keptOpen",
  async (c) => {
    const onScroll = vi.fn();
    await using screen = await render(
      <TooltipScrollDismissArea
        data-testid="timeline"
        onScrollCapture={onScroll}
        className="h-32 overflow-y-auto"
      >
        <TimelineAction shared={c.shared} />
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

    // One pixel keeps the pointer over the trigger, so only the scroll can close it.
    screen.getByTestId("timeline").element().scrollTop = 1;
    await vi.waitFor(() => expect(onScroll).toHaveBeenCalledOnce());

    if (c.keptOpen) await expect.element(page.getByText("Description")).toBeVisible();
    else await expect.element(page.getByText("Description")).not.toBeInTheDocument();
  },
);

it("refreshes an open shared tooltip's label and links aria-describedby on focus", async () => {
  await using screen = await render(
    <SharedTooltipProvider>
      <SharedTooltipTrigger label="Copy code" render={<button type="button" />}>
        Copy
      </SharedTooltipTrigger>
    </SharedTooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Copy" });
  await userEvent.keyboard("{Tab}");
  await expect.element(trigger).toHaveFocus();
  const popup = page.getByText("Copy code");
  await expect.element(popup).toBeVisible();
  const popupId = trigger.element().getAttribute("aria-describedby");
  expect(popupId).toBeTruthy();
  expect(document.getElementById(popupId!)?.textContent).toBe("Copy code");

  await screen.rerender(
    <SharedTooltipProvider>
      <SharedTooltipTrigger label="Copied" render={<button type="button" />}>
        Copy
      </SharedTooltipTrigger>
    </SharedTooltipProvider>,
  );
  await expect.element(page.getByText("Copied")).toBeVisible();

  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() => expect(trigger.element().getAttribute("aria-describedby")).toBeNull());
});

it("refreshes a pending shared tooltip if its label changes during the open delay", async () => {
  await using screen = await render(
    <SharedTooltipProvider>
      <SharedTooltipTrigger label="Copied" render={<button type="button" />}>
        Copy
      </SharedTooltipTrigger>
    </SharedTooltipProvider>,
  );
  const trigger = screen.getByRole("button", { name: "Copy" });
  await userEvent.hover(trigger);
  await screen.rerender(
    <SharedTooltipProvider>
      <SharedTooltipTrigger label="Copy code" render={<button type="button" />}>
        Copy
      </SharedTooltipTrigger>
    </SharedTooltipProvider>,
  );
  await expect.element(page.getByText("Copy code")).toBeVisible();
  expect(page.getByText("Copied").query()).toBeNull();
});
