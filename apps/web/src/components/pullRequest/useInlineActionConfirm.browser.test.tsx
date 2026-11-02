import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { useInlineActionConfirm } from "./useInlineActionConfirm";

function MergeButton({ scopeKey, onConfirm }: { scopeKey: string; onConfirm: () => void }) {
  const confirm = useInlineActionConfirm(scopeKey);
  return (
    <button type="button" {...confirm.props("merge", onConfirm)}>
      {confirm.isArmed("merge") ? "Confirm merge?" : "Merge"}
    </button>
  );
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
}

it("confirms on the second click and disarms on Escape", async () => {
  const onConfirm = vi.fn();
  await using screen = await render(<MergeButton scopeKey="a" onConfirm={onConfirm} />);
  const button = screen.getByRole("button");

  await userEvent.click(button);
  await expect.element(button).toHaveTextContent("Confirm merge?");
  expect(pressEscape().defaultPrevented).toBe(true);
  await expect.element(button).toHaveTextContent("Merge");

  await userEvent.click(button);
  await userEvent.click(button);
  expect(onConfirm).toHaveBeenCalledTimes(1);
  await expect.element(button).toHaveTextContent("Merge");
});

it("stops swallowing Escape once the scope changes", async () => {
  const onConfirm = vi.fn();
  await using screen = await render(<MergeButton scopeKey="a" onConfirm={onConfirm} />);
  const button = screen.getByRole("button");

  await userEvent.click(button);
  await expect.element(button).toHaveTextContent("Confirm merge?");
  await screen.rerender(<MergeButton scopeKey="b" onConfirm={onConfirm} />);
  await expect.element(button).toHaveTextContent("Merge");
  expect(pressEscape().defaultPrevented).toBe(false);

  await screen.rerender(<MergeButton scopeKey="a" onConfirm={onConfirm} />);
  await expect.element(button).toHaveTextContent("Merge");
});

// The hook's owner stays mounted while the armed button goes away, as when the primary
// action changes under an armed merge button.
function ToolbarWithMergeButton({ shown }: { shown: boolean }) {
  const confirm = useInlineActionConfirm("a");
  return shown ? (
    <button type="button" {...confirm.props("merge", () => undefined)}>
      {confirm.isArmed("merge") ? "Confirm merge?" : "Merge"}
    </button>
  ) : (
    <span>gone</span>
  );
}

it("stops swallowing Escape once the armed button unmounts", async () => {
  await using screen = await render(<ToolbarWithMergeButton shown />);
  const button = screen.getByRole("button");

  await userEvent.click(button);
  await expect.element(button).toHaveTextContent("Confirm merge?");
  await screen.rerender(<ToolbarWithMergeButton shown={false} />);
  await expect.element(screen.getByText("gone")).toBeVisible();
  expect(pressEscape().defaultPrevented).toBe(false);

  await screen.rerender(<ToolbarWithMergeButton shown />);
  await expect.element(screen.getByRole("button")).toHaveTextContent("Merge");
});

it.each(["merge", "enable-auto-merge"] as const)(
  "keeps a blocked %s action reachable without arming or performing it",
  async (primaryAction) => {
    const perform = vi.fn(async () => true);
    const { PullRequestPrimaryAction } = await import("./PullRequestDetailActions");
    const control = (mergeBlockedReason: string | null) => (
      <PullRequestPrimaryAction
        pullRequestKey="owner/repo/7"
        primaryAction={primaryAction}
        mergeBlockedReason={mergeBlockedReason}
        autoMergeArmed={false}
        armedAutoMergeLabel="Auto-merge enabled"
        pendingAutoMergeLabel="Auto-merge (squash)"
        selectedMergeMethod="squash"
        selectedMergeMethodLabel="Squash and merge"
        statePresentation={null}
        pendingAction={null}
        perform={perform}
        resolveConflicts={null}
      />
    );
    await using screen = await render(control("Checking stack membership…"));
    const button = screen.getByRole("button");
    await userEvent.tab();
    await expect.element(button).toHaveFocus();
    await expect.element(button).toHaveAccessibleDescription("Checking stack membership…");
    await userEvent.keyboard("{Enter}{Enter} ");
    expect(perform).not.toHaveBeenCalled();
    await screen.rerender(control(null));
    await userEvent.click(button);
    expect(perform).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(perform).toHaveBeenCalledExactlyOnceWith(primaryAction, "squash");
  },
);
