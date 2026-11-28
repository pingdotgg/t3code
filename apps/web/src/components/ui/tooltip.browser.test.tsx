import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "./combobox";
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

it("closes a hovered tooltip when the combobox list scrolls under a stationary pointer", async () => {
  await using screen = await render(
    <Combobox>
      <ComboboxTrigger>Projects</ComboboxTrigger>
      <ComboboxPopup render={<TooltipScrollDismissArea holdPositionOnExit />}>
        <ComboboxSearchInput aria-label="Search projects" />
        <ComboboxList>
          <ComboboxItem value="project">
            <Tooltip>
              <TooltipTrigger render={<span />}>Remote project</TooltipTrigger>
              <TooltipPopup>Remote machine</TooltipPopup>
            </Tooltip>
          </ComboboxItem>
          <div className="h-160" />
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>,
  );
  await userEvent.click(screen.getByText("Projects"));
  const trigger = page.getByText("Remote project");
  await userEvent.hover(trigger);
  const tooltip = page.getByText("Remote machine");
  await expect.element(tooltip).toBeVisible();

  trigger.element().closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!.scrollTop = 1;
  await expect.element(tooltip).not.toBeInTheDocument();

  await userEvent.unhover(trigger);
  await userEvent.hover(trigger);
  await expect.element(tooltip).toBeVisible();
});

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

it("closes the shared tooltip when its open trigger is removed", async () => {
  const tree = (showReaction: boolean) => (
    <SharedTooltipProvider>
      {showReaction ? (
        <SharedTooltipTrigger label="Ada reacted" render={<button type="button" />}>
          Reaction
        </SharedTooltipTrigger>
      ) : null}
      <SharedTooltipTrigger label="Add reaction" render={<button type="button" />}>
        Add
      </SharedTooltipTrigger>
    </SharedTooltipProvider>
  );
  await using screen = await render(tree(true));
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "Reaction" })).toHaveFocus();
  await expect.element(page.getByText("Ada reacted")).toBeVisible();

  // A refresh drops the reaction under the pointer; a removed trigger fires no pointerleave.
  await screen.rerender(tree(false));
  await expect.element(page.getByText("Ada reacted")).not.toBeInTheDocument();
});

it("closes the shared tooltip when its control becomes disabled", async () => {
  const tree = (disabled: boolean) => (
    <SharedTooltipProvider>
      <SharedTooltipTrigger
        label="Refresh status"
        render={<button type="button" disabled={disabled} />}
      >
        Refresh
      </SharedTooltipTrigger>
    </SharedTooltipProvider>
  );
  await using screen = await render(tree(false));
  // Hover, not focus: disabling a focused button blurs it, which would close the tooltip anyway.
  await userEvent.hover(screen.getByRole("button", { name: "Refresh" }));
  await expect.element(page.getByText("Refresh status")).toBeVisible();

  await screen.rerender(tree(true));
  await expect.element(page.getByText("Refresh status")).not.toBeInTheDocument();
});

it("keeps another trigger's pending open when a trigger is disabled", async () => {
  const tree = (firstDisabled: boolean) => (
    <SharedTooltipProvider>
      <SharedTooltipTrigger
        label="First tip"
        disabled={firstDisabled}
        render={<button type="button" />}
      >
        First
      </SharedTooltipTrigger>
      <SharedTooltipTrigger label="Second tip" render={<button type="button" />}>
        Second
      </SharedTooltipTrigger>
    </SharedTooltipProvider>
  );
  await using screen = await render(tree(false));
  await userEvent.hover(screen.getByRole("button", { name: "First" }));
  await userEvent.hover(screen.getByRole("button", { name: "Second" }));
  // The second tooltip is now waiting out its open delay when the first trigger is disabled.
  await screen.rerender(tree(true));
  await expect.element(page.getByText("Second tip")).toBeVisible();
});

it("shows the shared tooltip when keyboard focus lands on a control inside a wrapper", async () => {
  await using screen = await render(
    <SharedTooltipProvider>
      <SharedTooltipTrigger label="Maximize panel" render={<span />}>
        <button type="button">Maximize</button>
      </SharedTooltipTrigger>
    </SharedTooltipProvider>,
  );
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("button", { name: "Maximize" })).toHaveFocus();
  await expect.element(page.getByText("Maximize panel")).toBeVisible();
});

it("restores an enclosing shared tooltip when moving off a nested trigger back onto it", async () => {
  await using screen = await render(
    <SharedTooltipProvider>
      <SharedTooltipTrigger
        label="Thread details"
        side="right"
        render={<div className="flex w-60 items-center justify-between p-2" />}
      >
        <span>Thread title</span>
        <SharedTooltipTrigger label="Settle thread" render={<button type="button" />}>
          Settle
        </SharedTooltipTrigger>
      </SharedTooltipTrigger>
    </SharedTooltipProvider>,
  );

  await userEvent.hover(screen.getByText("Thread title"));
  await expect.element(page.getByText("Thread details")).toBeVisible();

  await userEvent.hover(screen.getByRole("button", { name: "Settle" }));
  await expect.element(page.getByText("Settle thread")).toBeVisible();

  const title = screen.getByText("Thread title");
  await userEvent.hover(title);
  const details = page.getByText("Thread details");
  await expect.element(details).toBeVisible();

  // The moving popup can cross the pointer and uncover the title after the row has regained hover.
  using _timers = fakeTimers();
  details
    .element()
    .dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: title.element() }));
  await act(() => vi.runOnlyPendingTimersAsync());
  expect(title.element().parentElement!.hasAttribute("aria-describedby")).toBe(true);
});

it("keeps a pending parent restore when leaving a disabled nested sibling", async () => {
  await using screen = await render(
    <SharedTooltipProvider>
      <SharedTooltipTrigger
        label="Thread details"
        side="right"
        render={<div className="flex w-60 items-center justify-between gap-2 p-2" />}
      >
        <span>Thread title</span>
        <SharedTooltipTrigger label="Disabled action" disabled render={<span />}>
          Inactive
        </SharedTooltipTrigger>
        <SharedTooltipTrigger label="Settle thread" render={<button type="button" />}>
          Settle
        </SharedTooltipTrigger>
      </SharedTooltipTrigger>
    </SharedTooltipProvider>,
  );

  await userEvent.hover(screen.getByRole("button", { name: "Settle" }));
  await userEvent.hover(screen.getByText("Inactive"));
  await userEvent.hover(screen.getByText("Thread title"));
  await expect.element(page.getByText("Thread details")).toBeVisible();
});

it("closes a nested tooltip when exiting both nested and enclosing triggers directly", async () => {
  await using screen = await render(
    <SharedTooltipProvider>
      <div className="flex flex-col gap-8 p-4">
        <SharedTooltipTrigger
          label="Thread details"
          side="right"
          render={<div className="flex w-60 items-center justify-between p-2" />}
        >
          <span>Thread title</span>
          <SharedTooltipTrigger label="Settle thread" render={<button type="button" />}>
            Settle
          </SharedTooltipTrigger>
        </SharedTooltipTrigger>
        <button type="button">Outside</button>
      </div>
    </SharedTooltipProvider>,
  );

  await userEvent.hover(screen.getByRole("button", { name: "Settle" }));
  await expect.element(page.getByText("Settle thread")).toBeVisible();

  await userEvent.hover(screen.getByRole("button", { name: "Outside" }));
  await expect.element(page.getByText("Settle thread")).not.toBeInTheDocument();
});
