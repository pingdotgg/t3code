import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { ThreadMoveDialog } from "./ThreadMoveDialog";
import { askThreadMove } from "./threadMoveDialogStore";

const copy = {
  title: "Leave this worktree?",
  from: "/worktrees/w",
  to: null,
  lines: ["The folder stays on disk with all its files until you remove it."],
  confirmLabel: "Move thread",
};

it("asks with the focus on Cancel and answers with the button the user picks", async () => {
  expect(await askThreadMove(copy)).toBe(false);

  // router: false because the dialog reads no route.
  await using screen = await render(<ThreadMoveDialog />, { router: false });
  const declined = askThreadMove(copy);
  await expect.element(screen.getByRole("heading", { name: copy.title })).toBeVisible();
  await expect.element(screen.getByText("/worktrees/w", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("A new scratch folder")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

  const confirmed = askThreadMove({ ...copy, to: "/repo" });
  expect(await declined).toBe(false);
  // The bare test page gives the popup no layout, so the backdrop covers the button.
  (screen.getByRole("button", { name: "Move thread" }).element() as HTMLElement).click();
  expect(await confirmed).toBe(true);
});
