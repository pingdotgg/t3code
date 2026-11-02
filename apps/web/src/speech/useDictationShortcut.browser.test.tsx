import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

import { act, render } from "../../test/render";
import { BackgroundThreadContext } from "../components/chat/backgroundThread";
import { useDictationShortcut } from "./useDictationShortcut";

const settings = vi.hoisted(() => ({ mode: "toggle" as "toggle" | "hold" | "auto" }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => settings.mode }));
vi.mock("../commandPaletteBus", () => ({ isCommandPaletteOpen: () => false }));
vi.mock("../lib/terminalFocus", () => ({ getTerminalFocusOwner: () => null }));

function createSpeech() {
  return {
    available: true,
    state: { phase: "idle", error: null, errorAction: null } as VoiceInputState<true>,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
}
function Editors({
  main,
  comment,
  showComment = true,
}: {
  main: ReturnType<typeof createSpeech>;
  comment: ReturnType<typeof createSpeech>;
  showComment?: boolean;
}) {
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
      {showComment ? <Comment speech={comment} /> : null}
    </>
  );
}
function Comment({ speech }: { speech: ReturnType<typeof createSpeech> }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    targetRef: ref,
  });
  return <textarea ref={ref} aria-label="Comment" />;
}
const key = (type: "keydown" | "keyup", value = "v") =>
  window.dispatchEvent(
    new KeyboardEvent(type, {
      key: value,
      code: value === "v" ? "KeyV" : "Escape",
      ctrlKey: value === "v",
      altKey: value === "v",
      bubbles: true,
      cancelable: true,
    }),
  );

function setup() {
  settings.mode = "toggle";
  const main = createSpeech();
  const comment = createSpeech();
  return {
    main,
    comment,
    view: (props?: { key?: string; showComment?: boolean; background?: boolean }) => (
      <BackgroundThreadContext value={props?.background ?? false}>
        <Editors
          main={main}
          comment={comment}
          key={props?.key}
          showComment={props?.showComment ?? true}
        />
      </BackgroundThreadContext>
    ),
  };
}

it("dictates into the focused comment instead of the main composer", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(fixture.comment.start).toHaveBeenCalledOnce();
  expect(fixture.main.start).not.toHaveBeenCalled();
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Main"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(fixture.main.start).toHaveBeenCalledOnce();
});

it("stops and cancels the recording owner even after focus moves", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  fixture.comment.state = { phase: "recording", error: null, errorAction: null };
  await screen.rerender(fixture.view());
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Main"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
    key("keydown", "Escape");
  });
  expect(fixture.comment.stop).toHaveBeenCalledOnce();
  expect(fixture.comment.cancel).toHaveBeenCalledOnce();
  expect(fixture.main.start).not.toHaveBeenCalled();
});

it("finishes hold dictation on release", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  settings.mode = "hold";
  await screen.rerender(fixture.view({ key: settings.mode }));
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  expect(fixture.comment.start).toHaveBeenCalledOnce();
  expect(fixture.comment.stop).toHaveBeenCalledOnce();
});

it("leaves dictation and Escape to the modal over a background thread", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view({ background: true }));
  await act(() => {
    expect(key("keydown")).toBe(true);
    key("keyup");
  });
  expect(fixture.main.start).not.toHaveBeenCalled();
  fixture.main.state = { phase: "recording", error: null, errorAction: null };
  await screen.rerender(fixture.view({ background: true }));
  await act(() => {
    expect(key("keydown")).toBe(true);
    expect(key("keydown", "Escape")).toBe(true);
  });
  expect(fixture.main.stop).not.toHaveBeenCalled();
  expect(fixture.main.cancel).not.toHaveBeenCalled();
  await screen.rerender(fixture.view());
  await act(() => key("keydown"));
  expect(fixture.main.stop).toHaveBeenCalledOnce();
});

it("finishes a held recording after its thread moves behind a modal", async () => {
  const fixture = setup();
  settings.mode = "hold";
  await using screen = await render(fixture.view());
  await act(() => key("keydown"));
  await screen.rerender(fixture.view({ background: true }));
  await act(() => key("keyup"));
  expect(fixture.main.start).toHaveBeenCalledOnce();
  expect(fixture.main.stop).toHaveBeenCalledOnce();
});

it("does not stop a later session when the editor closes during preparation", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  settings.mode = "hold";
  let resolve!: () => void;
  fixture.comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await screen.rerender(fixture.view({ key: settings.mode }));
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  await screen.rerender(fixture.view({ showComment: false }));
  await act(async () => resolve());
  expect(fixture.comment.stop).not.toHaveBeenCalled();
});

it("does not finish a new recording when a cancelled hold start resolves", async () => {
  const fixture = setup();
  await using screen = await render(fixture.view());
  settings.mode = "hold";
  let resolve!: () => void;
  fixture.comment.start.mockImplementationOnce(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await screen.rerender(fixture.view({ key: settings.mode }));
  screen.container.querySelector<HTMLTextAreaElement>('[aria-label="Comment"]')!.focus();
  await act(() => {
    key("keydown");
    key("keyup");
  });
  fixture.comment.state = { phase: "preparing", error: null, errorAction: null };
  await act(() => key("keydown", "Escape"));
  fixture.comment.state = { phase: "idle", error: null, errorAction: null };
  await act(() => key("keydown"));
  await act(async () => resolve());
  expect(fixture.comment.start).toHaveBeenCalledTimes(2);
  expect(fixture.comment.cancel).toHaveBeenCalledOnce();
  expect(fixture.comment.stop).not.toHaveBeenCalled();
});
