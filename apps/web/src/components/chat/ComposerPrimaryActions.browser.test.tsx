import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

it.each([
  { name: "lets the stop shortcut through", stops: true, reachesWindow: 1, stillOpen: true },
  { name: "closes on any other Escape", stops: false, reachesWindow: 0, stillOpen: false },
])("$name while the tooltip is open", async ({ stops, reachesWindow, stillOpen }) => {
  const isStopShortcutEvent = vi.fn((event: KeyboardEvent) => event.shiftKey === stops);
  await using _screen = await render(
    <TooltipProvider>
      <ComposerPrimaryActions
        compact={false}
        canOperateThread
        pendingAction={null}
        isRunning
        canInterrupt
        stopShortcutLabel="Shift+Esc"
        isStopShortcutEvent={isStopShortcutEvent}
        showPlanFollowUpPrompt={false}
        promptHasText={false}
        isSendBusy={false}
        sendDisabledReason={null}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent={false}
        onPreviousPendingQuestion={() => {}}
        onInterrupt={() => {}}
        onImplementPlanInNewThread={() => {}}
      />
    </TooltipProvider>,
  );
  await userEvent.hover(page.getByRole("button", { name: "Stop generation" }));
  const tooltip = page.getByText("Interrupt (Shift+Esc)");
  await expect.element(tooltip).toBeVisible();
  const reachedWindow = vi.fn();
  window.addEventListener("keydown", reachedWindow);

  await userEvent.keyboard("{Shift>}{Escape}{/Shift}");

  window.removeEventListener("keydown", reachedWindow);
  const escapes = reachedWindow.mock.calls.filter(([event]) => event.key === "Escape");
  expect(escapes).toHaveLength(reachesWindow);
  if (stillOpen) await expect.element(tooltip).toBeVisible();
  else await expect.element(tooltip).not.toBeInTheDocument();
});
