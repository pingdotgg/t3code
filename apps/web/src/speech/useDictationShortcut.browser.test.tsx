import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createRef, type RefObject } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { useDictationShortcut } from "./useDictationShortcut";

vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => "hold" }));

function Probe({
  speech,
  targetRef,
}: {
  speech: Parameters<typeof useDictationShortcut>[0]["speech"];
  targetRef?: RefObject<HTMLElement | null>;
}) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    ...(targetRef ? { targetRef } : {}),
  });
  return null;
}

const press = (repeat = false) =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "D",
      code: "KeyD",
      ctrlKey: !/Mac/i.test(navigator.platform),
      metaKey: /Mac/i.test(navigator.platform),
      shiftKey: true,
      cancelable: true,
      repeat,
    }),
  );

function actions(available: boolean) {
  return {
    available,
    state: { phase: "idle" as const, error: null, errorAction: null },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
  };
}

it("leaves the browser shortcut alone when dictation is off", async () => {
  const speech = actions(false);
  await using _screen = await render(<Probe speech={speech} />);
  expect(press()).toBe(true);
  expect(speech.start).not.toHaveBeenCalled();
});

it("stops on a new press when the OS omitted keyup, but ignores autorepeat", async () => {
  const speech = actions(true);
  await using screen = await render(<Probe speech={speech} />);
  expect(press()).toBe(false);
  expect(speech.start).toHaveBeenCalledOnce();
  await screen.rerender(
    <Probe speech={{ ...speech, state: { ...speech.state, phase: "recording" } }} />,
  );
  press(true);
  expect(speech.stop).not.toHaveBeenCalled();
  press();
  expect(speech.stop).toHaveBeenCalledOnce();
});

it("finishes a released hold after startup even if the chord was pressed again while preparing", async () => {
  const speech = actions(true);
  let finishStart!: () => void;
  const startup = new Promise<void>((resolve) => {
    finishStart = resolve;
  });
  speech.start.mockReturnValue(startup);
  await using screen = await render(<Probe speech={speech} />);
  press();
  await screen.rerender(
    <Probe speech={{ ...speech, state: { ...speech.state, phase: "preparing" } }} />,
  );
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
  press();
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyD" }));
  finishStart();
  await startup;
  expect(speech.start).toHaveBeenCalledOnce();
  expect(speech.stop).toHaveBeenCalledOnce();
});

const escape = () =>
  new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });

const recording = () => ({
  ...actions(true),
  state: { phase: "recording" as const, error: null, errorAction: null },
});

it("lets Escape in another dictation editor reach that editor instead of canceling the recording", async () => {
  const speech = recording();
  const commentRef = createRef<HTMLTextAreaElement>();
  const fieldEscape = vi.fn();
  await using screen = await render(
    <>
      <Probe speech={speech} />
      <Probe speech={actions(true)} targetRef={commentRef} />
      <textarea
        aria-label="Comment"
        ref={commentRef}
        onKeyDown={(event) => {
          if (event.key === "Escape") fieldEscape();
        }}
      />
    </>,
  );
  const field = screen.getByRole("textbox", { name: "Comment" }).element();
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("expected the comment textarea");
  field.focus();
  field.dispatchEvent(escape());
  expect(speech.cancel).not.toHaveBeenCalled();
  expect(fieldEscape).toHaveBeenCalledOnce();
});

it("cancels the recording on Escape in a text field that does not dictate", async () => {
  const speech = recording();
  await using screen = await render(
    <>
      <Probe speech={speech} />
      <input aria-label="Search" />
    </>,
  );
  const field = screen.getByRole("textbox", { name: "Search" }).element();
  if (!(field instanceof HTMLInputElement)) throw new Error("expected the search field");
  field.focus();
  field.dispatchEvent(escape());
  expect(speech.cancel).toHaveBeenCalledOnce();
});
