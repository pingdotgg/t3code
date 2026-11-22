import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

import "~/index.css";

it("stays open while saving and after a failed save, then closes once a retry saves", async () => {
  let finishSave: (saved: boolean) => void = () => {};
  const onSelect = vi
    .fn<() => Promise<boolean>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    )
    .mockResolvedValue(true);
  const onOpenChange = vi.fn();
  await using _screen = await render(
    <ProjectIconPickerDialog
      current={{ kind: "monogram", text: "AB", color: "blue" }}
      projectName="Project"
      open
      onOpenChange={onOpenChange}
      onSelect={onSelect}
    />,
  );
  const saveButton = page.getByRole("button", { name: "Save icon" });

  await userEvent.click(saveButton);
  await expect.element(saveButton).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  finishSave(false);

  await expect.element(saveButton).toBeEnabled();
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.click(saveButton);
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onSelect).toHaveBeenCalledTimes(2);
});
