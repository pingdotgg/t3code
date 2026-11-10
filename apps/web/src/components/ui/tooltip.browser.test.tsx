import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipScrollDismissArea,
  TooltipTrigger,
} from "./tooltip";

it("blocks sidebar hover cards until scrolling settles", async () => {
  const onOpenChange = vi.fn();
  await using screen = await render(
    <TooltipScrollDismissArea suppressHoverWhileScrolling>
      <div data-testid="viewport">
        <TooltipProvider delay={50} closeDelay={0} timeout={400}>
          <Tooltip>
            <TooltipTrigger>First row</TooltipTrigger>
            <TooltipPopup>First details</TooltipPopup>
          </Tooltip>
          <Tooltip onOpenChange={onOpenChange}>
            <TooltipTrigger>Second row</TooltipTrigger>
            <TooltipPopup>Second details</TooltipPopup>
          </Tooltip>
        </TooltipProvider>
      </div>
    </TooltipScrollDismissArea>,
  );
  using _timers = fakeTimers();
  await act(() => screen.getByTestId("viewport").element().dispatchEvent(new Event("scroll")));
  await screen.getByRole("button", { name: "Second row" }).hover();
  await act(() => vi.advanceTimersByTime(50));
  await expect.element(page.getByText("Second details")).not.toBeInTheDocument();
  expect(onOpenChange.mock.calls.some(([open, details]) => open && !details.isCanceled)).toBe(
    false,
  );

  await act(() => vi.advanceTimersByTime(200));
  await screen.getByRole("button", { name: "First row" }).hover();
  await screen.getByRole("button", { name: "Second row" }).hover();
  await act(() => vi.advanceTimersByTime(600));
  await expect.element(page.getByText("Second details")).toBeInTheDocument();
});
