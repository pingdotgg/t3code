import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { UpdateEverythingDialog } from "./UpdateEverythingDialog";

it("lets a remote user update the laptop without updating the PC host", async () => {
  const pc = EnvironmentId.make("pc");
  const laptop = EnvironmentId.make("laptop");
  const onConfirm = vi.fn();
  await using _screen = await render(
    <UpdateEverythingDialog
      open
      onOpenChange={() => {}}
      selectable
      version="0.2.0"
      providerCount={2}
      rows={[
        {
          environmentId: pc,
          label: "PC host",
          app: "this-app",
          providers: ["Codex"],
          skipped: null,
        },
        {
          environmentId: laptop,
          label: "Laptop",
          app: "desktop-app",
          providers: ["Claude"],
          skipped: null,
        },
      ]}
      restarts={[]}
      onConfirm={onConfirm}
    />,
  );
  await expect.element(page.getByRole("heading", { name: "Update 2 machines?" })).toBeVisible();
  await userEvent.click(page.getByRole("checkbox", { name: "PC host" }));
  await expect.element(page.getByRole("heading", { name: "Update 1 machine?" })).toBeVisible();
  await expect.element(page.getByText(/1 provider update$/)).toBeVisible();
  await userEvent.click(page.getByRole("checkbox", { name: "Laptop" }));
  await expect.element(page.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
  await userEvent.click(page.getByRole("checkbox", { name: "Laptop" }));
  await userEvent.click(page.getByRole("button", { name: "Update", exact: true }));
  expect(onConfirm).toHaveBeenCalledWith({ environmentIds: [laptop], updateLocal: false });
});
