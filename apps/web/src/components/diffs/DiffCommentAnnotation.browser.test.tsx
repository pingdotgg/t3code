import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { registerCommands } from "~/shortcuts/dispatcher";
import { act, render } from "../../../test/render";
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
  expect(heard).toEqual([{ key: "Escape", consumed: true }]);

  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(onComment).toHaveBeenCalledExactlyOnceWith("Draft");
});
