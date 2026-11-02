import { useRef } from "react";
import { render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";

import { composerSubmissionIntentForKey } from "../composer-logic";
import { useDictationSubmissionShortcut } from "./useDictationSubmissionShortcut";

vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));

const submitted = vi.hoisted(() => vi.fn());

function Probe({ preparing = false }: { preparing?: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  useDictationSubmissionShortcut({
    enabled: !preparing,
    formRef,
    onKeyDown: (event) => {
      const intent = composerSubmissionIntentForKey({
        event,
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
        isSoftwareKeyboardOpen: false,
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

function setup() {
  submitted.mockClear();
}

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
  setup();
  await using screen = await render(<Probe />);
  const { container } = screen;
  const editor = container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  editor.focus();
  editor.blur();
  expect(document.activeElement).toBe(document.body);
  expect(enter(document.body).defaultPrevented).toBe(true);
  expect(submitted).toHaveBeenCalledExactlyOnceWith("foreground");
});

it("handles a focused read-only composer once and leaves Shift+Enter alone", async () => {
  setup();
  await using screen = await render(<Probe />);
  const { container } = screen;
  const editor = container.querySelector<HTMLElement>('[data-testid="composer-editor"]')!;
  expect(enter(editor, true).defaultPrevented).toBe(false);
  expect(enter(editor).defaultPrevented).toBe(true);
  expect(submitted).toHaveBeenCalledTimes(1);
});

it("does not intercept citation fields, buttons, or other editors", async () => {
  setup();
  await using screen = await render(<Probe />);
  const { container } = screen;
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
  setup();
  await using screen = await render(<Probe preparing />);
  expect(enter(document.body).defaultPrevented).toBe(false);
  expect(submitted).not.toHaveBeenCalled();
  await screen.rerender(<Probe />);
  expect(enter(document.body).defaultPrevented).toBe(true);
  expect(submitted).toHaveBeenCalledTimes(1);
});
