import { page, userEvent } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

import "~/index.css";

it("stays open with the server's reason when saving fails, and saves on retry", async () => {
  const message = "Project monograms must contain at most two characters.";
  let rejectSave: (error: unknown) => void = () => {};
  const onSelect = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    )
    .mockResolvedValue(undefined);
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
  rejectSave({
    name: "ProjectMutationError",
    message: "Failed to mutate project.",
    cause: { name: "ProjectCommandInvariantError", message },
  });

  await expect.element(page.getByRole("alert")).toHaveTextContent(message);
  await expect.element(saveButton).toBeEnabled();
  expect(onOpenChange).not.toHaveBeenCalled();

  await userEvent.click(saveButton);
  await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  expect(onSelect).toHaveBeenCalledTimes(2);
});
