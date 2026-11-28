import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { registerCommands } from "~/shortcuts/dispatcher";
import { act, render } from "../../../test/render";
import { RightPanelSheet } from "../RightPanelSheet";
import { DiffCommentAnnotation } from "./DiffCommentAnnotation";

it("leaves IME keys in a diff comment to the composition", async () => {
  const onCancel = vi.fn();
  const onComment = vi.fn();
  await using screen = await render(
    <DiffCommentAnnotation
      kind="draft"
      rangeLabel="3"
      text=""
      onCancel={onCancel}
      onComment={onComment}
    />,
  );
  const heard: Array<{ key: string; consumed: boolean }> = [];
  using _observer = {
    [Symbol.dispose]: registerCommands(
      {},
      { observe: (event, consumed) => heard.push({ key: event.key, consumed }) },
    ),
  };
  const draft = screen.getByRole("textbox", { name: "Comment on lines 3" });
  await draft.fill("Draft");

  for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const keys of [
      { key: "Escape" },
      { key: "Enter", ctrlKey: true },
      { key: "Enter", metaKey: true },
    ]) {
      const label = JSON.stringify({ ...keys, ...composing });
      const event = new KeyboardEvent("keydown", {
        ...keys,
        ...composing,
        bubbles: true,
        cancelable: true,
      });
      await act(() => draft.element().dispatchEvent(event));
      expect(event.defaultPrevented, label).toBe(false);
      // The right panel sheet and pull requests page close on an Escape that reaches them.
      expect(heard, label).toEqual([]);
    }
  }
  expect(onCancel).not.toHaveBeenCalled();
  expect(onComment).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onCancel).toHaveBeenCalledOnce();
  expect(heard).toEqual([]);

  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onComment).toHaveBeenCalledExactlyOnceWith("Draft");
});

it("Escape cancels a diff comment without closing the right panel sheet", async () => {
  const onCloseSheet = vi.fn();
  function Draft() {
    const [open, setOpen] = useState(true);
    if (!open) return null;
    return (
      <DiffCommentAnnotation
        kind="draft"
        rangeLabel="3"
        text=""
        onCancel={() => setOpen(false)}
        onComment={() => {}}
      />
    );
  }
  await using _screen = await render(
    <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
      <Draft />
    </RightPanelSheet>,
  );
  const draft = page.getByRole("textbox", { name: "Comment on lines 3" });
  await act(() => (draft.element() as HTMLElement).focus());

  await userEvent.keyboard("{Escape}");
  await expect.element(draft).not.toBeInTheDocument();
  expect(onCloseSheet).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onCloseSheet).toHaveBeenCalledOnce();
});
