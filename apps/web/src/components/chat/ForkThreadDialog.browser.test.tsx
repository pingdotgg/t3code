import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ForkThreadDialog } from "./ForkThreadDialog";

it("cancels without forking and submits the selected destination once", async () => {
  const onClose = vi.fn();
  let finish!: () => void;
  const onSelect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await using screen = await render(
    <ForkThreadDialog
      worktreePath={null}
      branch="main"
      isGitRepo
      onClose={onClose}
      onSelect={onSelect}
    />,
  );
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSelect).not.toHaveBeenCalled();
  await screen.rerender(
    <ForkThreadDialog
      key="reopened"
      worktreePath={null}
      branch="main"
      isGitRepo
      onClose={onClose}
      onSelect={onSelect}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: /Fork in a new worktree/ }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith({
    type: "worktree",
    baseRef: "main",
    startFromOrigin: false,
  });
  await expect
    .element(screen.getByRole("button", { name: /Fork in the current checkout/ }))
    .toBeDisabled();
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
  finish();
  await expect
    .element(screen.getByRole("button", { name: /Fork in the current checkout/ }))
    .toBeEnabled();
});
