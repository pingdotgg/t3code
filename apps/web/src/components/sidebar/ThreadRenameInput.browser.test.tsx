import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ThreadRenameInput } from "./ThreadRenameInput";

function RenameHarness(props: { onCommit: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState("Original title");
  return (
    <>
      <ThreadRenameInput
        title={title}
        onTitleChange={setTitle}
        onCommit={props.onCommit}
        onCancel={props.onCancel}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it("cancels without committing when the title input blurs", async () => {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  await using screen = await render(<RenameHarness onCommit={onCommit} onCancel={onCancel} />, {
    // Rename input is not route-bound; skip the default router shell.
    router: false,
  });
  const input = screen.getByRole("textbox", { name: "Thread title" });
  await input.fill("Edited title");
  await screen.getByText("Outside rename").click();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onCommit).not.toHaveBeenCalled();
});

it("commits on Enter without a follow-up cancel from blur", async () => {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  await using screen = await render(<RenameHarness onCommit={onCommit} onCancel={onCancel} />, {
    // Rename input is not route-bound; skip the default router shell.
    router: false,
  });
  await screen.getByRole("textbox", { name: "Thread title" }).fill("Edited title");
  await userEvent.keyboard("{Enter}");
  expect(onCommit).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
});
