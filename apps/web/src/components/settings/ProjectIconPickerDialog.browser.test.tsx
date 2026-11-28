import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

import "~/index.css";

it("Escape in the icon search clears it without closing the dialog", async () => {
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <ProjectIconPickerDialog
      current={null}
      projectName="Project"
      open
      onOpenChange={onOpenChange}
      onSelect={() => {}}
    />,
  );
  const search = page.getByRole("searchbox", { name: "Search Lucide icons" });
  await expect.element(search).toHaveAttribute("type", "text");
  await userEvent.fill(search, "rocket");
  for (const composition of [
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
  ]) {
    // Safari ends the composition just before the Escape keydown.
    await act(() => {
      search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      search
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
    });
    await expect.element(search).toHaveValue("rocket");
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(search).toHaveValue("");
  await expect.element(search).toHaveFocus();
  // Holding Escape repeats the keydown, which must not also close the dialog.
  await act(() => {
    search
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }));
  });
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onOpenChange.mock.calls.map(([open]) => open)).toEqual([false]);
});
