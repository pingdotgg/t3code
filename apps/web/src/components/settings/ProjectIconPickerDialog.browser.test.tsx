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

it("saves on plain Enter in monogram and custom emoji inputs, not icon search", async () => {
  const onOpenChange = vi.fn();
  const onSelect = vi.fn();
  await using _screen = await render(
    <ProjectIconPickerDialog
      current={null}
      projectName="Project"
      open
      onOpenChange={onOpenChange}
      onSelect={onSelect}
    />,
  );

  const search = page.getByRole("searchbox", { name: "Search Lucide icons" });
  await userEvent.fill(search, "rocket");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.click(page.getByRole("button", { name: "Monogram" }));
  const letters = page.getByLabelText("Letters");
  await userEvent.fill(letters, "ABC");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.fill(letters, "AB");
  for (const eventInit of [
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Enter", repeat: true },
    { key: "Enter", shiftKey: true },
  ]) {
    await act(() => {
      letters
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { ...eventInit, bubbles: true }));
    });
  }
  expect(onSelect).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenLastCalledWith(
    expect.objectContaining({ kind: "monogram", text: "AB" }),
  );
  expect(onOpenChange).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);

  await userEvent.click(page.getByRole("button", { name: "Emoji" }));
  const customEmoji = page.getByRole("textbox", { name: "Custom emoji" });
  await userEvent.fill(customEmoji, "🦊");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledTimes(2);
  expect(onSelect).toHaveBeenLastCalledWith({ kind: "emoji", emoji: "🦊" });
  expect(onOpenChange).toHaveBeenCalledTimes(2);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
});
