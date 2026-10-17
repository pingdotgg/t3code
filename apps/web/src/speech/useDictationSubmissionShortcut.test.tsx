// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { composerSubmissionIntentForKey } from "../composer-logic";
import { useDictationSubmissionShortcut } from "./useDictationSubmissionShortcut";

vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));

let root: Root;
let container: HTMLDivElement;
const submitted = vi.fn();

function Probe({ preparing = false }: { preparing?: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  useDictationSubmissionShortcut({
    enabled: !preparing,
    formRef,
    onKeyDown: (event) => {
      const intent = composerSubmissionIntentForKey({
        event,
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        isMobileViewport: false,
        isDraftThread: true,
        sendShortcut: "enter",
        prompt: "",
      });
      if (!intent) return;
      event.preventDefault();
      event.stopPropagation();
      submitted(intent);
    },
  });
  return (
    <form ref={formRef}>
      <div data-testid="composer-editor" contentEditable={false} tabIndex={0}>
        <textarea aria-label="Citation comment" />
      </div>
      <button type="button">Send</button>
    </form>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  submitted.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function enter(target: Element, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

it("handles Enter when the frozen composer loses focus to the page", async () => {
  await act(() => root.render(<Probe />));
  const editor = container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  editor.focus();
  editor.blur();
  expect(document.activeElement).toBe(document.body);
  expect(enter(document.body).defaultPrevented).toBe(true);
  expect(submitted).toHaveBeenCalledExactlyOnceWith("foreground");
});

it("handles a focused read-only composer once and leaves Shift+Enter alone", async () => {
  await act(() => root.render(<Probe />));
  const editor = container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  expect(enter(editor, true).defaultPrevented).toBe(false);
  expect(enter(editor).defaultPrevented).toBe(true);
  expect(submitted).toHaveBeenCalledTimes(1);
});

it("does not intercept citation fields, buttons, or other editors", async () => {
  await act(() => root.render(<Probe />));
  const other = document.createElement("textarea");
  document.body.append(other);
  try {
    expect(enter(other).defaultPrevented).toBe(false);
    expect(enter(container.querySelector("textarea")!).defaultPrevented).toBe(false);
    expect(enter(container.querySelector("button")!).defaultPrevented).toBe(false);
    expect(submitted).not.toHaveBeenCalled();
  } finally {
    other.remove();
  }
});

it("blocks the shortcut during preparation and enables it afterward", async () => {
  await act(() => root.render(<Probe preparing />));
  expect(enter(document.body).defaultPrevented).toBe(false);
  expect(submitted).not.toHaveBeenCalled();
  await act(() => root.render(<Probe />));
  expect(enter(document.body).defaultPrevented).toBe(true);
  expect(submitted).toHaveBeenCalledTimes(1);
});
