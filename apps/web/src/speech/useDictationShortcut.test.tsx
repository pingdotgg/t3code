// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

import { useDictationShortcut } from "./useDictationShortcut";

const settings = vi.hoisted(() => ({ mode: "toggle" as "toggle" | "hold" | "auto" }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => settings.mode }));
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => null }));

const main = {
  available: true,
  state: { phase: "idle", error: null, errorAction: null } as VoiceInputState<true>,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  cancel: vi.fn(),
};
const comment = {
  ...main,
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  cancel: vi.fn(),
};
let root: Root;
let container: HTMLDivElement;
function Editors({ showComment = true }: { showComment?: boolean }) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech: main,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
  });
  return (
    <>
      <textarea aria-label="Main" />
      {showComment ? <Comment /> : null}
    </>
  );
}
function Comment() {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech: comment,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    targetRef: ref,
  });
  return <textarea ref={ref} aria-label="Comment" />;
}
const key = (type: "keydown" | "keyup", value = "d") =>
  window.dispatchEvent(
    new KeyboardEvent(type, {
      key: value,
      code: value === "d" ? "KeyD" : "Escape",
      ctrlKey: value === "d",
      shiftKey: value === "d",
      bubbles: true,
      cancelable: true,
    }),
  );

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings.mode = "toggle";
  vi.clearAllMocks();
  main.state = { phase: "idle", error: null, errorAction: null };
  comment.state = { phase: "idle", error: null, errorAction: null };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<Editors />));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("dictates into the focused comment instead of the main composer", async () => {
  container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(comment.start).toHaveBeenCalledOnce();
  expect(main.start).not.toHaveBeenCalled();
  container.querySelector<HTMLTextAreaElement>('[aria-label="Main"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(main.start).toHaveBeenCalledOnce();
});

it("stops and cancels the recording owner even after focus moves", async () => {
  comment.state = { phase: "recording", error: null, errorAction: null };
  await act(() => root.render(<Editors />));
  container.querySelector<HTMLTextAreaElement>('[aria-label="Main"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
    key("keydown", "Escape");
  });
  expect(comment.stop).toHaveBeenCalledOnce();
  expect(comment.cancel).toHaveBeenCalledOnce();
  expect(main.start).not.toHaveBeenCalled();
});

it("finishes hold dictation on release", async () => {
  settings.mode = "hold";
  await act(() => root.render(<Editors key={settings.mode} />));
  container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(comment.start).toHaveBeenCalledOnce();
  expect(comment.stop).toHaveBeenCalledOnce();
});

it("does not stop a later session when the editor closes during preparation", async () => {
  settings.mode = "hold";
  let resolve!: () => void;
  comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await act(() => root.render(<Editors key={settings.mode} />));
  container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  await act(() => root.render(<Editors showComment={false} />));
  await act(async () => resolve());
  expect(comment.stop).not.toHaveBeenCalled();
});

it("does not finish a new recording when a cancelled hold start resolves", async () => {
  settings.mode = "hold";
  let resolve!: () => void;
  comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await act(() => root.render(<Editors key={settings.mode} />));
  container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  comment.state = { phase: "preparing", error: null, errorAction: null };
  await act(() => key("keydown", "Escape"));
  comment.state = { phase: "idle", error: null, errorAction: null };
  await act(() => key("keydown"));
  await act(async () => resolve());
  expect(comment.start).toHaveBeenCalledTimes(2);
  expect(comment.cancel).toHaveBeenCalledOnce();
  expect(comment.stop).not.toHaveBeenCalled();
});
