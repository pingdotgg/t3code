import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { render } from "../../../test/render";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

it("opens implementation actions with a mouse while the composer is resting", async () => {
  const onImplementPlanInNewThread = vi.fn();
  await using _screen = await render(
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning={false}
      canInterrupt={false}
      showPlanFollowUpPrompt
      promptHasText={false}
      isSendBusy={false}
      sendDisabledReason={null}
      isConnecting={false}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent={false}
      preserveComposerFocusOnPointerDown
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={onImplementPlanInNewThread}
    />,
  );

  await userEvent.click(page.getByRole("button", { name: "Implementation actions" }));
  const item = page.getByRole("menuitem", { name: "Implement in a new thread" });
  await expect.element(item).toBeVisible();
  await userEvent.click(item);
  expect(onImplementPlanInNewThread).toHaveBeenCalledTimes(1);
});
