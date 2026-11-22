import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, fakeTimers, render } from "../../../test/render";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { makeThreadFixture } from "../../test-fixtures";
import { SharedTooltipProvider } from "../ui/shared-tooltip";
import { SortableThreadRow } from "./SidebarThreadRow";

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

it("suppresses the row preview while its snooze menu is open", async () => {
  const noop = () => {};
  await using screen = await render(
    <AppAtomRegistryProvider>
      <SharedTooltipProvider openDelayMs={80}>
        <ul className="m-16 w-44">
          <SortableThreadRow
            thread={makeThreadFixture({ title: "My thread" })}
            sortableId="my-thread"
            sortableDisabled
            contextDrag={false}
            variant="card"
            variantAction="settle"
            settlementSupported={false}
            snoozeSupported
            pinningSupported={false}
            isPinned={false}
            dropVerb={null}
            dragOverPinned={false}
            sweepAction={null}
            snoozeWakeLabelText={null}
            wokeAt={null}
            isActive={false}
            isRouteThread={false}
            readOpensPullRequestsInRightPanel={() => false}
            jumpLabel={null}
            environmentLabel={null}
            environmentMachine="desktop"
            project={null}
            projectDisplayName={null}
            providerEntryByInstanceId={new Map()}
            timestampFormat="locale"
            onThreadClick={noop}
            onThreadActivate={noop}
            onStartRename={noop}
            onRenameTitleChange={noop}
            onCommitRename={noop}
            onCancelRename={noop}
            isRenaming={false}
            renamingTitle=""
            onContextMenu={noop}
            onSettle={noop}
            onActionSweepStart={noop}
            onUnsettle={noop}
            onSnooze={noop}
            onUnsnooze={noop}
            onUnpin={noop}
            onAcknowledgeWoke={noop}
          />
        </ul>
      </SharedTooltipProvider>
    </AppAtomRegistryProvider>,
  );
  using _timers = fakeTimers();
  const row = screen.getByTestId("sidebar-row-card");
  const title = screen.getByText("My thread");
  const snooze = screen.getByRole("button", { name: "Snooze thread" });

  await userEvent.hover(title);
  (snooze.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  const menu = page.getByRole("menu");
  await expect.element(menu).toBeVisible();
  await act(() => vi.advanceTimersByTime(80));
  expect(row.element().getAttribute("aria-describedby")).toBeNull();

  // Dispatch a new entry while the menu's pointer shield covers the row.
  await act(() => {
    row.element().dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    row
      .element()
      .dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    vi.advanceTimersByTime(80);
  });
  expect(row.element().getAttribute("aria-describedby")).toBeNull();

  await userEvent.keyboard("{Escape}");
  await expect.element(menu).not.toBeInTheDocument();
  (snooze.element() as HTMLElement).blur();
  await userEvent.unhover(title);
  await userEvent.hover(title);
  await act(() => vi.advanceTimersByTime(80));
  await expect.element(page.getByRole("tooltip").getByText("My thread")).toBeVisible();

  await userEvent.hover(snooze);
  expect(row.element().getAttribute("aria-describedby")).toBeNull();
});
