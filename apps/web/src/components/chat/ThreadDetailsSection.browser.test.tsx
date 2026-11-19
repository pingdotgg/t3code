import "~/index.css";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

it("collapses with the pointer and reopens with the keyboard without losing a draft", async () => {
  await using screen = await render(
    <ThreadDetailsSection headingId="workspace-heading" title="Workspace">
      <input aria-label="Command draft" defaultValue="" />
    </ThreadDetailsSection>,
  );
  const toggle = page.getByRole("button", { name: "Workspace", exact: true });
  const draft = page.getByRole("textbox", { name: "Command draft", includeHidden: true });
  await userEvent.fill(draft, "npm run dev");
  await userEvent.click(toggle);
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(draft).not.toBeVisible();
  await expect.element(screen.getByRole("region", { name: "Workspace" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(draft).toBeVisible();
  await expect.element(draft).toHaveValue("npm run dev");
});

it("keeps a section with no controls out of the layout", async () => {
  await using screen = await render(
    <ThreadDetailsSection headingId="empty-heading" title="Workspace">
      <div />
    </ThreadDetailsSection>,
  );
  await expect
    .element(screen.getByRole("region", { name: "Workspace", includeHidden: true }))
    .not.toBeVisible();
});
