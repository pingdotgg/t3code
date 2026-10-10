// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./alert-dialog";
import { Button } from "./button";
import { Dialog, DialogAction, DialogFooter, DialogPopup, DialogTitle } from "./dialog";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function renderAlert({
  variant = "default",
  disabled = false,
}: { variant?: "default" | "destructive"; disabled?: boolean } = {}) {
  const onAction = vi.fn();
  const onCancel = vi.fn();
  await act(async () => {
    root.render(
      <AlertDialog open>
        <AlertDialogPopup>
          <AlertDialogTitle>Install update?</AlertDialogTitle>
          <input aria-label="Name" />
          <textarea aria-label="Note" />
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />} onClick={onCancel}>
              Cancel
            </AlertDialogClose>
            <AlertDialogAction variant={variant} disabled={disabled} onClick={onAction}>
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>,
    );
  });
  return {
    onAction,
    onCancel,
    cancel: getButton("Cancel"),
    input: document.querySelector("input")!,
    textarea: document.querySelector("textarea")!,
  };
}

function getButton(label: string) {
  return [...document.querySelectorAll("button")].find((button) => button.textContent === label)!;
}

function press(target: Element, key: string, init: KeyboardEventInit = {}) {
  let notPrevented = true;
  act(() => {
    notPrevented = target.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
  return { prevented: !notPrevented };
}

describe("AlertDialog keyboard", () => {
  it("runs the primary action when Enter is pressed on the focused Cancel button", async () => {
    const { onAction, onCancel, cancel } = await renderAlert();

    expect(press(cancel, "Enter").prevented).toBe(true);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("runs the primary action from a single-line text field", async () => {
    const { onAction, input } = await renderAlert();

    expect(press(input, "Enter").prevented).toBe(true);
    expect(onAction).toHaveBeenCalledOnce();
  });

  it("leaves Space to the focused button", async () => {
    const { onAction, cancel } = await renderAlert();

    expect(press(cancel, " ").prevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("leaves Enter on Cancel when the primary action is destructive", async () => {
    const { onAction, cancel } = await renderAlert({ variant: "destructive" });

    expect(press(cancel, "Enter").prevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("does not run a disabled primary action", async () => {
    const { onAction, cancel } = await renderAlert({ disabled: true });

    expect(press(cancel, "Enter").prevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it("leaves Enter to multi-line fields", async () => {
    const { onAction, textarea } = await renderAlert();

    expect(press(textarea, "Enter").prevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each([
    ["an IME composition", { isComposing: true }],
    ["a held key", { repeat: true }],
    ["a modifier", { metaKey: true }],
  ])("ignores Enter during %s", async (_, init) => {
    const { onAction, cancel } = await renderAlert();

    expect(press(cancel, "Enter", init).prevented).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("Dialog keyboard", () => {
  it("runs the primary action when Enter is pressed on a secondary button", async () => {
    const onAction = vi.fn();
    const onCancel = vi.fn();
    await act(async () => {
      root.render(
        <Dialog open>
          <DialogPopup>
            <DialogTitle>Merge stack?</DialogTitle>
            <DialogFooter>
              <Button variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <DialogAction onClick={onAction}>Merge stack</DialogAction>
            </DialogFooter>
          </DialogPopup>
        </Dialog>,
      );
    });

    expect(press(getButton("Cancel"), "Enter").prevented).toBe(true);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
