import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { SharedTooltipProvider, SharedTooltipTrigger, useSharedTooltip } from "./shared-tooltip";
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

it("opens a shared tooltip in place the first time", async () => {
  await using _screen = await render(
    // Away from the corner the unpositioned popup sits in, so a slide from there is a real move.
    <div className="p-40">
      <SharedTooltipProvider>
        <SharedTooltipTrigger label="Description" render={<button type="button" />}>
          Target
        </SharedTooltipTrigger>
      </SharedTooltipProvider>
    </div>,
  );
  // Focus opens it at once, while a position transition would still be running.
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByText("Description")).toBeVisible();
  const moving = document
    .getAnimations()
    .filter((animation) => animation instanceof CSSTransition)
    .map((transition) => transition.transitionProperty)
    .filter((property) => ["top", "left", "right", "bottom", "transform"].includes(property));
  expect(moving).toEqual([]);
});

function DwellTrigger({
  label,
  renderLabel,
  disabled = false,
}: {
  label: string;
  renderLabel: () => string;
  disabled?: boolean;
}) {
  const tooltip = useSharedTooltip({ render: renderLabel, contentKey: label, disabled });
  return (
    <button type="button" {...tooltip}>
      {label}
    </button>
  );
}

it.each(["open", "recently closed"] as const)(
  "opens only the final target when sweeping past a %s shared tooltip",
  async (previous) => {
    const renderSecond = vi.fn(() => "Second details");
    const renderThird = vi.fn(() => "Third details");
    await using screen = await render(
      <SharedTooltipProvider openDelayMs={25} switchDelayMs={80} closeGraceMs={30}>
        <div className="mt-16 flex gap-4">
          <DwellTrigger label="First" renderLabel={() => "First details"} />
          <DwellTrigger label="Second" renderLabel={renderSecond} />
          <DwellTrigger label="Third" renderLabel={renderThird} />
        </div>
      </SharedTooltipProvider>,
    );
    using _timers = fakeTimers();
    const first = screen.getByRole("button", { name: "First" });
    await userEvent.hover(first);
    await act(() => vi.advanceTimersByTime(25));
    await expect.element(page.getByText("First details")).toBeVisible();
    if (previous === "recently closed") {
      await userEvent.unhover(first);
      await act(() => vi.advanceTimersByTime(30));
      expect(first.element().getAttribute("aria-describedby")).toBeNull();
    }

    await userEvent.hover(screen.getByRole("button", { name: "Second" }));
    await act(() => vi.advanceTimersByTime(60));
    await userEvent.hover(screen.getByRole("button", { name: "Third" }));
    await act(() => vi.advanceTimersByTime(79));
    expect(renderSecond).not.toHaveBeenCalled();
    expect(renderThird).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTime(1));
    await expect.element(page.getByText("Third details")).toBeVisible();
    expect(renderSecond).not.toHaveBeenCalled();
  },
);

it("cancels pending and open shared tooltips when their trigger becomes disabled", async () => {
  const renderLabel = vi.fn(() => "Preview details");
  const content = (disabled: boolean) => (
    <SharedTooltipProvider openDelayMs={30}>
      <DwellTrigger label="Preview" renderLabel={renderLabel} disabled={disabled} />
    </SharedTooltipProvider>
  );
  await using screen = await render(content(false));
  using _timers = fakeTimers();
  const trigger = screen.getByRole("button", { name: "Preview" });
  await userEvent.hover(trigger);
  await screen.rerender(content(true));
  await act(() => vi.advanceTimersByTime(30));
  expect(renderLabel).not.toHaveBeenCalled();

  await userEvent.unhover(trigger);
  await userEvent.hover(trigger);
  await act(() => vi.advanceTimersByTime(30));
  expect(renderLabel).not.toHaveBeenCalled();

  await screen.rerender(content(false));
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByText("Preview details")).toBeVisible();
  await screen.rerender(content(true));
  expect(trigger.element().getAttribute("aria-describedby")).toBeNull();
});

it("keyboard focus bypasses switch dwell and Escape dismisses the shared tooltip", async () => {
  await using screen = await render(
    <SharedTooltipProvider openDelayMs={60_000} switchDelayMs={60_000}>
      <DwellTrigger label="First" renderLabel={() => "First details"} />
      <DwellTrigger label="Second" renderLabel={() => "Second details"} />
    </SharedTooltipProvider>,
  );
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByText("First details")).toBeVisible();
  await userEvent.keyboard("{Tab}");
  const second = screen.getByRole("button", { name: "Second" });
  await expect.element(second).toHaveFocus();
  await expect.element(page.getByText("Second details")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(second).toHaveFocus();
  await expect.element(page.getByText("Second details")).not.toBeInTheDocument();
});

it("keeps a pending target dwell alive when the previously open anchor unmounts", async () => {
  const view = (showFirst: boolean) => (
    <SharedTooltipProvider openDelayMs={25} switchDelayMs={80} closeGraceMs={30}>
      <div className="mt-16 flex gap-4">
        <DwellTrigger label="Second" renderLabel={() => "Second details"} />
        {showFirst ? <DwellTrigger label="First" renderLabel={() => "First details"} /> : null}
      </div>
    </SharedTooltipProvider>
  );
  await using screen = await render(view(true));
  using _timers = fakeTimers();
  await userEvent.hover(screen.getByRole("button", { name: "First" }));
  await act(() => vi.advanceTimersByTime(25));
  await expect.element(page.getByText("First details")).toBeVisible();

  await userEvent.hover(screen.getByRole("button", { name: "Second" }));
  await act(() => vi.advanceTimersByTime(40));
  await screen.rerender(view(false));
  await act(() => vi.advanceTimersByTime(40));
  await expect.element(page.getByText("Second details")).toBeVisible();
});

it("closes the open tooltip when leaving or unmounting a pending target during switch dwell", async () => {
  const view = (showSecond: boolean) => (
    <SharedTooltipProvider openDelayMs={25} switchDelayMs={80} closeGraceMs={30}>
      <div className="mt-16 flex gap-4">
        <DwellTrigger label="First" renderLabel={() => "First details"} />
        {showSecond ? <DwellTrigger label="Second" renderLabel={() => "Second details"} /> : null}
      </div>
    </SharedTooltipProvider>
  );
  await using screen = await render(view(true));
  using _timers = fakeTimers();

  // Case 1: open First, cross Second, then leave Second before its switch dwell expires.
  await userEvent.hover(screen.getByRole("button", { name: "First" }));
  await act(() => vi.advanceTimersByTime(25));
  await expect.element(page.getByText("First details")).toBeVisible();

  const second = screen.getByRole("button", { name: "Second" });
  await userEvent.hover(second);
  await act(() => vi.advanceTimersByTime(40));
  await userEvent.unhover(second);
  await act(() => vi.advanceTimersByTime(100));
  expect(document.querySelector('[role="tooltip"][data-open]')).toBeNull();

  // Case 2: open First, hover Second, then unmount Second midway through its switch dwell.
  await userEvent.hover(screen.getByRole("button", { name: "First" }));
  await act(() => vi.advanceTimersByTime(25));
  await expect.element(page.getByText("First details")).toBeVisible();

  await userEvent.hover(second);
  await act(() => vi.advanceTimersByTime(40));
  await screen.rerender(view(false));
  await act(() => vi.advanceTimersByTime(100));
  expect(document.querySelector('[role="tooltip"][data-open]')).toBeNull();
});
