// @vitest-environment jsdom

import { act, createRef } from "react";
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

async function render(ui: React.ReactNode) {
  await act(async () => root.render(ui));
  // Base UI moves focus into the popup after it mounts.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
}

function focusedLabel() {
  return document.activeElement?.textContent;
}

function renderAlert({ disabled = false }: { disabled?: boolean } = {}) {
  return render(
    <AlertDialog open>
      <AlertDialogPopup>
        <AlertDialogTitle>Install update?</AlertDialogTitle>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <AlertDialogAction disabled={disabled}>Confirm</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>,
  );
}

describe("dialog initial focus", () => {
  it("focuses the primary action of an alert dialog", async () => {
    await renderAlert();

    expect(focusedLabel()).toBe("Confirm");
  });

  it("keeps focus on Cancel when the primary action is disabled", async () => {
    await renderAlert({ disabled: true });

    expect(focusedLabel()).toBe("Cancel");
  });

  it("focuses the primary action of a dialog", async () => {
    await render(
      <Dialog open>
        <DialogPopup>
          <DialogTitle>Merge stack?</DialogTitle>
          <DialogFooter>
            <Button variant="outline">Cancel</Button>
            <DialogAction>Merge stack</DialogAction>
          </DialogFooter>
        </DialogPopup>
      </Dialog>,
    );

    expect(focusedLabel()).toBe("Merge stack");
  });

  it("lets a caller's initialFocus win", async () => {
    const cancelRef = createRef<HTMLButtonElement>();
    await render(
      <Dialog open>
        <DialogPopup initialFocus={cancelRef}>
          <DialogTitle>Merge stack?</DialogTitle>
          <DialogFooter>
            <Button ref={cancelRef} variant="outline">
              Cancel
            </Button>
            <DialogAction>Merge stack</DialogAction>
          </DialogFooter>
        </DialogPopup>
      </Dialog>,
    );

    expect(focusedLabel()).toBe("Cancel");
  });
});
