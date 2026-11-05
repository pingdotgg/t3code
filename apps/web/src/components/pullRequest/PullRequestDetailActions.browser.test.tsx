import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { PullRequestPrimaryAction } from "./PullRequestDetailActions";

it("lets keyboard users read why merging is blocked without performing a merge", async () => {
  const perform = vi.fn(async () => true);
  await using screen = await render(
    <TooltipProvider>
      <button>Before merge</button>
      <PullRequestPrimaryAction
        pullRequestKey="owner/repo#1"
        primaryAction="blocked"
        autoMergeArmed={false}
        armedAutoMergeLabel="Auto-merge enabled"
        pendingAutoMergeLabel="Enable auto-merge"
        selectedMergeMethod="squash"
        selectedMergeMethodLabel="Squash and merge"
        statePresentation={null}
        pendingAction={null}
        perform={perform}
        resolveConflicts={null}
      />
      <button>After merge</button>
    </TooltipProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Before merge" }));
  await userEvent.tab();
  const blocked = screen.getByRole("button", { name: "Merge blocked" });
  await expect.element(blocked).toHaveFocus();
  await expect
    .element(page.getByRole("tooltip"))
    .toHaveTextContent(
      "The repository's rules block merging until their requirements are met, such as resolving conversations",
    );
  await expect
    .element(blocked)
    .toHaveAccessibleDescription(
      "The repository's rules block merging until their requirements are met, such as resolving conversations",
    );
  await expect.element(blocked).toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Enter} ");
  expect(perform).not.toHaveBeenCalled();
  await userEvent.tab();
  await expect.element(screen.getByRole("button", { name: "After merge" })).toHaveFocus();
});
