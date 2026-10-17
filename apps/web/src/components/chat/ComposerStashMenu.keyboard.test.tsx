// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Dialog, DialogPopup } from "../ui/dialog";
import { ComposerStashMenu } from "./ComposerStashMenu";

const entries = ["first", "second"].map((id) => ({
  id,
  createdAt: new Date(0).toISOString(),
  prompt: `${id} prompt`,
  attachments: [],
  droppedImageNames: [],
}));

const getAnimationsDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  if (getAnimationsDescriptor) {
    Object.defineProperty(Element.prototype, "getAnimations", getAnimationsDescriptor);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderWithDialog() {
  const composerFormRef = createRef<HTMLFormElement>();
  const onRestore = vi.fn();
  const onDelete = vi.fn();
  const onClose = vi.fn();
  const onDialogKeyDown = vi.fn();
  await act(() =>
    root.render(
      <>
        <form ref={composerFormRef}>
          <div data-testid="composer-editor" contentEditable suppressContentEditableWarning />
        </form>
        <ComposerStashMenu
          composerFormRef={composerFormRef}
          entries={entries}
          stashShortcutLabel="Ctrl+S"
          onRestore={onRestore}
          onDelete={onDelete}
          onClose={onClose}
        />
        <Dialog open>
          <DialogPopup aria-label="Command palette">
            <input aria-label="Search commands" onKeyDown={onDialogKeyDown} />
          </DialogPopup>
        </Dialog>
      </>,
    ),
  );
  return { onRestore, onDelete, onClose, onDialogKeyDown };
}

async function press(target: HTMLElement, key: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true });
  await act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe("stash keyboard scope", () => {
  it.each([
    { name: "Enter", key: { key: "Enter" } },
    { name: "Ctrl+Backspace", key: { key: "Backspace", ctrlKey: true } },
    { name: "Cmd+Backspace", key: { key: "Backspace", metaKey: true } },
    { name: "Escape", key: { key: "Escape" } },
  ])("leaves $name in a dialog input to the dialog", async ({ key }) => {
    const { onRestore, onDelete, onClose, onDialogKeyDown } = await renderWithDialog();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search commands"]')!;
    await act(() => input.focus());
    await press(input, key);
    expect(onRestore).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(onDialogKeyDown).toHaveBeenCalledOnce();
  });

  it("still restores and deletes from the composer editor", async () => {
    const { onRestore, onDelete } = await renderWithDialog();
    const editor = host.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
    expect((await press(editor, { key: "Enter" })).defaultPrevented).toBe(true);
    expect(onRestore).toHaveBeenCalledExactlyOnceWith(entries[0]);
    expect((await press(editor, { key: "Backspace", ctrlKey: true })).defaultPrevented).toBe(true);
    expect(onDelete).toHaveBeenCalledExactlyOnceWith(entries[0]);
  });
});
