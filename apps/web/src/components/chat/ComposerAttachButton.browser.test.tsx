import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerAttachButton } from "./ComposerAttachmentStrip";

it("opens the Files and Folder menu with a mouse click and picks a folder", async () => {
  const attachFolder = vi.fn();
  await using _screen = await render(
    <ComposerAttachButton
      addComposerAttachments={async () => true}
      focusComposer={() => {}}
      attachFolder={attachFolder}
    />,
  );

  await userEvent.click(page.getByRole("button", { name: "Attach files or a folder" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Folder…" }));

  expect(attachFolder).toHaveBeenCalledOnce();
});
