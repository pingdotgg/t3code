import { createRef } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { requestConfirmDialog, resetConfirmDialogForTests } from "~/confirmDialog";
import { act, render } from "../../../test/render";
import { ConfirmDialogHost } from "../ConfirmDialogHost";
import { Button } from "./button";
import {
  Dialog,
  DialogAction,
  DialogClose,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "./dialog";

describe("dialog initial focus", () => {
  it.each([
    { label: "generic", options: undefined, focused: "Cancel", confirmed: false },
    {
      label: "destructive opt-in",
      options: { variant: "destructive", initialFocus: "confirm" },
      focused: "Cancel",
      confirmed: false,
    },
    { label: "opt-in", options: { initialFocus: "confirm" }, focused: "Confirm", confirmed: true },
  ] as const)(
    "focuses $focused for a $label confirmation",
    async ({ options, focused, confirmed }) => {
      resetConfirmDialogForTests();
      await using _screen = await render(<ConfirmDialogHost />);
      let confirmation: Promise<boolean> | undefined;
      await act(() => {
        confirmation = requestConfirmDialog("Continue?", options);
      });

      await expect.element(page.getByRole("button", { name: focused, exact: true })).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      await expect(confirmation).resolves.toBe(confirmed);
    },
  );

  it("focuses the dialog action and keeps the caller's popup ref", async () => {
    const popup = createRef<HTMLDivElement>();
    await using _screen = await render(
      <Dialog>
        <DialogTrigger>Open retry</DialogTrigger>
        <DialogPopup ref={popup}>
          <DialogTitle>Import failed</DialogTitle>
          <DialogClose>Cancel</DialogClose>
          <DialogAction>Try again</DialogAction>
        </DialogPopup>
      </Dialog>,
    );
    await act(() => page.getByRole("button", { name: "Open retry" }).element().focus());
    await userEvent.keyboard("{Enter}");

    await expect.element(page.getByRole("button", { name: "Try again" })).toHaveFocus();
    expect(popup.current).toBe(page.getByRole("dialog").element());
  });

  it.each(["disabled action", "caller initialFocus"] as const)(
    "falls back to Cancel for a %s",
    async (reason) => {
      const cancel = createRef<HTMLButtonElement>();
      await using _screen = await render(
        <Dialog defaultOpen>
          <DialogPopup {...(reason === "caller initialFocus" ? { initialFocus: cancel } : {})}>
            <DialogTitle>Install update?</DialogTitle>
            <DialogClose ref={cancel} render={<Button variant="secondary" />}>
              Cancel
            </DialogClose>
            <DialogAction disabled={reason === "disabled action"}>Install</DialogAction>
          </DialogPopup>
        </Dialog>,
      );

      await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
    },
  );

  it("focuses the popup instead of the action when opened by touch", async () => {
    await using _screen = await render(
      <Dialog>
        <DialogTrigger>Open installer</DialogTrigger>
        <DialogPopup>
          <DialogTitle>Install relay client</DialogTitle>
          <DialogClose>Cancel</DialogClose>
          <DialogAction>Install</DialogAction>
        </DialogPopup>
      </Dialog>,
    );

    const trigger = page.getByRole("button", { name: "Open installer" }).element();
    await act(() => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }),
      );
      trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
      trigger.dispatchEvent(
        new PointerEvent("click", { bubbles: true, pointerType: "touch", detail: 1 }),
      );
    });

    await expect.element(page.getByRole("dialog")).toHaveFocus();
  });
});
