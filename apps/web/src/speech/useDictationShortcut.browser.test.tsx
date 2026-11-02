import { useRef } from "react";
import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

import { useDictationShortcut } from "./useDictationShortcut";

const settings = vi.hoisted(() => ({ mode: "toggle" as "toggle" | "hold" | "auto" }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => settings.mode }));
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => null }));

const { main, comment } = vi.hoisted(() => {
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
  return { main, comment };
});
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

function setup() {
  settings.mode = "toggle";
  vi.clearAllMocks();
  main.state = { phase: "idle", error: null, errorAction: null };
  comment.state = { phase: "idle", error: null, errorAction: null };
}

it("dictates into the focused comment instead of the main composer", async () => {
  setup();
  await using screen = await render(<Editors />);
  const { container } = screen;
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
  setup();
  await using screen = await render(<Editors />);
  const { container } = screen;
  comment.state = { phase: "recording", error: null, errorAction: null };
  await screen.rerender(<Editors />);
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
  setup();
  await using screen = await render(<Editors />);
  const { container } = screen;
  settings.mode = "hold";
  await screen.rerender(<Editors key={settings.mode} />);
  container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(comment.start).toHaveBeenCalledOnce();
  expect(comment.stop).toHaveBeenCalledOnce();
});

it("does not stop a later session when the editor closes during preparation", async () => {
  setup();
  await using screen = await render(<Editors />);
  const { container } = screen;
  settings.mode = "hold";
  let resolve!: () => void;
  comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await screen.rerender(<Editors key={settings.mode} />);
  container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  await screen.rerender(<Editors showComment={false} />);
  await act(async () => resolve());
  expect(comment.stop).not.toHaveBeenCalled();
});

it("does not finish a new recording when a cancelled hold start resolves", async () => {
  setup();
  await using screen = await render(<Editors />);
  const { container } = screen;
  settings.mode = "hold";
  let resolve!: () => void;
  comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await screen.rerender(<Editors key={settings.mode} />);
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
