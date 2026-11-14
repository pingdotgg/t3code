import { createRef } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { requestConfirmDialog, resetConfirmDialogForTests } from "~/confirmDialog";
import { act, render } from "../../../test/render";
import { applyGlassAppearance } from "../../appearanceGlass";
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

function setup(opacity: number) {
  const root = document.documentElement;
  const attributes = ["style", "class"].map((name) => ({ name, value: root.getAttribute(name) }));
  const motion = document.createElement("style");
  motion.textContent = '[data-slot="dialog-backdrop"] { transition: none !important; }';
  document.head.append(motion);
  applyGlassAppearance(root, opacity);
  return {
    [Symbol.dispose]() {
      motion.remove();
      for (const { name, value } of attributes) {
        if (value === null) root.removeAttribute(name);
        else root.setAttribute(name, value);
      }
    },
  };
}

it.each([80, 100])(
  "applies glass opacity %i and updates backdrop filtering without changing dimming",
  async (initialOpacity) => {
    using _appearance = setup(initialOpacity);
    await using _screen = await render(
      <Dialog open>
        <DialogPopup aria-label="Example dialog">Dialog content</DialogPopup>
      </Dialog>,
    );
    await expect.element(page.getByRole("dialog", { name: "Example dialog" })).toBeVisible();
    const backdrop = document.querySelector('[data-slot="dialog-backdrop"]');
    if (!(backdrop instanceof HTMLElement)) throw new Error("Missing dialog backdrop");
    const root = document.documentElement;
    expect(getComputedStyle(backdrop).backdropFilter).toBe(
      initialOpacity === 100 ? "none" : "blur(4px)",
    );

    for (const appearance of ["light", "dark"]) {
      root.classList.toggle("dark", appearance === "dark");
      const tint = getComputedStyle(backdrop).backgroundColor;
      for (const opacity of [100, 95, 100, 80]) {
        applyGlassAppearance(root, opacity);
        const opaque = opacity === 100;
        await vi.waitFor(() =>
          expect(getComputedStyle(backdrop).backdropFilter).toBe(opaque ? "none" : "blur(4px)"),
        );
        expect(root.style.getPropertyValue("--glass-opacity")).toBe(`${opacity}%`);
        expect(root.style.getPropertyValue("--glass-blur")).toBe(opaque ? "0px" : "");
        expect(root.style.getPropertyValue("--dialog-backdrop-filter")).toBe(opaque ? "none" : "");
        expect(getComputedStyle(backdrop).backgroundColor).toBe(tint);
      }
    }
  },
);

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
            <DialogClose ref={cancel} render={<Button variant="outline" />}>
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
