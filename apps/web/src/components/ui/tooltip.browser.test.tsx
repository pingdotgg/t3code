import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "./tooltip";

it.each([false, true])(
  "keeps a keyboard-focused tooltip open on scroll (hover first: %s)",
  async (hoverFirst) => {
    const onScroll = vi.fn();
    await using screen = await render(
      <TooltipScrollDismissArea
        data-testid="timeline"
        onScrollCapture={onScroll}
        className="h-32 overflow-y-auto"
      >
        <Tooltip>
          <TooltipTrigger>Timeline action</TooltipTrigger>
          <TooltipPopup>Keyboard description</TooltipPopup>
        </Tooltip>
        <div className="h-96" />
      </TooltipScrollDismissArea>,
    );
    const trigger = screen.getByRole("button", { name: "Timeline action" });
    if (hoverFirst) await userEvent.hover(trigger);
    await userEvent.keyboard("{Tab}");
    await expect.element(trigger).toHaveFocus();
    expect(trigger.element().matches(":focus-visible")).toBe(true);
    await expect.element(page.getByText("Keyboard description")).toBeVisible();
    screen.getByTestId("timeline").element().scrollTop = 20;
    await vi.waitFor(() => expect(onScroll).toHaveBeenCalledOnce());
    await expect.element(page.getByText("Keyboard description")).toBeVisible();
    await expect.element(trigger).toHaveFocus();
  },
);
