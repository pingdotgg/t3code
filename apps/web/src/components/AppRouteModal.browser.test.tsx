import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal, AppRouteModalClose } from "./AppRouteModal";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });
});

function ModalLauncher() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Settings launcher</button>
      {open ? (
        <AppRouteModal label="Settings">
          <CommitOnBlurField onCommit={() => {}} />
          <AppRouteModalClose />
        </AppRouteModal>
      ) : null}
    </>
  );
}

it.each(["Escape", "Close"])("returns focus to the launcher on %s", async (method) => {
  await using screen = await render(<ModalLauncher />);
  const launcher = screen.getByRole("button", { name: "Settings launcher" });
  await launcher.click();
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  if (method === "Escape") await userEvent.keyboard("{Escape}");
  else
    (
      page.getByRole("button", { name: "Close", exact: true }).element() as HTMLButtonElement
    ).click();
  await expect.element(launcher).toHaveFocus();
});
