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

it("keeps a focused tooltip tracked when the pointer enters a disabled tooltip", async () => {
  await using screen = await render(
    <TooltipScrollDismissArea
      dismissFocused
      data-testid="scroller"
      className="h-32 overflow-y-auto"
    >
      <Tooltip>
        <TooltipTrigger>Focused action</TooltipTrigger>
        <TooltipPopup>Focused description</TooltipPopup>
      </Tooltip>
      <Tooltip disabled>
        <TooltipTrigger render={<span />}>Unavailable action</TooltipTrigger>
        <TooltipPopup>Disabled description</TooltipPopup>
      </Tooltip>
      <div className="h-96" />
    </TooltipScrollDismissArea>,
  );
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByText("Focused description")).toBeVisible();
  await userEvent.hover(screen.getByText("Unavailable action"));
  await expect.element(page.getByText("Focused description")).toBeVisible();
  screen.getByTestId("scroller").element().scrollTop = 20;
  await expect.element(page.getByText("Focused description")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Focused action" })).toHaveFocus();
});

it("keeps a tooltip through focus scrolling and dismisses it on the next scroll", async () => {
  const onScroll = vi.fn();
  await using screen = await render(
    <>
      <button>Start navigation</button>
      <TooltipScrollDismissArea
        dismissFocused
        data-testid="scroller"
        onScrollCapture={onScroll}
        className="h-32 overflow-y-auto"
      >
        <div className="h-96" />
        <Tooltip>
          <TooltipTrigger>Offscreen action</TooltipTrigger>
          <TooltipPopup>Offscreen description</TooltipPopup>
        </Tooltip>
        <div className="h-96" />
      </TooltipScrollDismissArea>
    </>,
  );
  const scroller = screen.getByTestId("scroller").element();
  await userEvent.click(screen.getByRole("button", { name: "Start navigation" }));
  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() => {
    expect(scroller.scrollTop).toBeGreaterThan(0);
    expect(onScroll).toHaveBeenCalled();
  });
  await expect.element(screen.getByRole("button", { name: "Offscreen action" })).toHaveFocus();
  await expect.element(page.getByText("Offscreen description")).toBeVisible();
  scroller.scrollTop += 20;
  await expect.element(page.getByText("Offscreen description")).not.toBeInTheDocument();
});
