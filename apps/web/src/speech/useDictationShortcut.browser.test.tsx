import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createRef, type RefObject } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { useDictationShortcut, type DictationKeyHandlers } from "./useDictationShortcut";

const settings = vi.hoisted(() => ({ mode: "hold" as "hold" | "auto" | "toggle" }));
vi.mock("../hooks/useSettings", () => ({ useClientSettings: () => settings.mode }));

type ShortcutInput = Parameters<typeof useDictationShortcut>[0];

function Probe({
  speech,
  targetRef,
  subscribeKeys,
}: {
  speech: ShortcutInput["speech"];
  targetRef?: RefObject<HTMLElement | null>;
  subscribeKeys?: ShortcutInput["subscribeKeys"];
}) {
  useDictationShortcut({
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    speech,
    disabled: false,
    terminalOpen: false,
    modelPickerOpen: false,
    ...(targetRef ? { targetRef } : {}),
    ...(subscribeKeys ? { subscribeKeys, ownsFocus: () => true } : {}),
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

function actions(available: boolean, mode: typeof settings.mode = "hold") {
  settings.mode = mode;
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

it.each(["KeyD", "MetaLeft", "ShiftLeft"])(
  "finishes a hold released with %s after startup even if pressed again while preparing",
  async (code) => {
    const speech = actions(true);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
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
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        code,
        key: code === "MetaLeft" ? "Meta" : code === "ShiftLeft" ? "Shift" : "D",
      }),
    );
    press();
    window.dispatchEvent(
      new KeyboardEvent("keyup", {
        code,
        key: code === "MetaLeft" ? "Meta" : code === "ShiftLeft" ? "Shift" : "D",
      }),
    );
    expect(speech.stop).not.toHaveBeenCalled();
    finishStart();
    await startup;
    expect(speech.start).toHaveBeenCalledOnce();
    expect(speech.stop).toHaveBeenCalledOnce();
  },
);

it.each([
  { mode: "hold", duration: 0, stops: 1 },
  { mode: "auto", duration: 300, stops: 1 },
  { mode: "auto", duration: 299, stops: 0 },
  { mode: "toggle", duration: 300, stops: 0 },
] as const)(
  "handles modifier release without letter keyup in $mode after $duration ms",
  async ({ mode, duration, stops }) => {
    const speech = actions(true, mode);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using screen = await render(<Probe speech={speech} />);
    using clock = vi.spyOn(performance, "now").mockReturnValue(0);
    press();
    await screen.rerender(
      <Probe speech={{ ...speech, state: { ...speech.state, phase: "recording" } }} />,
    );
    clock.mockReturnValue(duration);
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "a", code: "KeyA", metaKey: true, shiftKey: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Alt", code: "AltLeft", metaKey: true, shiftKey: true }),
    );
    await Promise.resolve();
    expect(speech.stop).not.toHaveBeenCalled();
    window.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Meta", code: "MetaLeft", shiftKey: true }),
    );
    await Promise.resolve();
    expect(speech.stop).toHaveBeenCalledTimes(stops);
    clock.mockReturnValue(1000);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", code: "ShiftLeft" }));
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "d", code: "KeyD" }));
    await Promise.resolve();
    expect(speech.stop).toHaveBeenCalledTimes(stops);
    if (stops === 0) press();
    expect(speech.stop).toHaveBeenCalledOnce();
  },
);

const escape = () =>
  new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true });

const recording = () => ({
  ...actions(true),
  state: { phase: "recording" as const, error: null, errorAction: null },
});

it("lets Escape in another dictation editor reach that editor instead of canceling the recording", async () => {
  const speech = recording();
  const commentRef = createRef<HTMLTextAreaElement>();
  const editorEscape = vi.fn();
  await using screen = await render(
    <>
      <Probe speech={speech} />
      <Probe speech={actions(true)} targetRef={commentRef} />
      <div
        role="dialog"
        aria-label="Edit citation comment"
        onKeyDown={(event) => {
          if (event.key === "Escape") editorEscape();
        }}
      >
        <textarea aria-label="Comment" ref={commentRef} />
        <button type="button">Cancel</button>
      </div>
    </>,
  );
  for (const control of [
    screen.getByRole("textbox", { name: "Comment" }).element(),
    screen.getByRole("button", { name: "Cancel" }).element(),
  ]) {
    if (!(control instanceof HTMLElement)) throw new Error("expected a comment editor control");
    control.focus();
    control.dispatchEvent(escape());
  }
  expect(speech.cancel).not.toHaveBeenCalled();
  expect(editorEscape).toHaveBeenCalledTimes(2);
});

it("lets Escape in another editor of the recording editor's dialog reach that editor", async () => {
  const speech = recording();
  const replyRef = createRef<HTMLTextAreaElement>();
  const otherReplyRef = createRef<HTMLTextAreaElement>();
  await using screen = await render(
    <>
      <Probe speech={speech} targetRef={replyRef} />
      <Probe speech={actions(true)} targetRef={otherReplyRef} />
      <div role="dialog" aria-label="Pull request">
        <textarea aria-label="Reply A" ref={replyRef} />
        <textarea aria-label="Reply B" ref={otherReplyRef} />
      </div>
    </>,
  );
  const other = screen.getByRole("textbox", { name: "Reply B" }).element();
  if (!(other instanceof HTMLElement)) throw new Error("expected a reply editor");
  other.focus();
  other.dispatchEvent(escape());
  expect(speech.cancel).not.toHaveBeenCalled();
});

it("cancels the recording on Escape outside other shown dictation editors", async () => {
  const speech = recording();
  const reviewRef = createRef<HTMLTextAreaElement>();
  const commentRef = createRef<HTMLTextAreaElement>();
  await using screen = await render(
    <>
      <Probe speech={speech} targetRef={reviewRef} />
      <Probe speech={actions(true)} targetRef={commentRef} />
      <input aria-label="Search" />
      <div role="dialog" aria-label="Pull request">
        <textarea aria-label="Review" ref={reviewRef} />
        <div hidden>
          <textarea aria-label="Comment" ref={commentRef} />
        </div>
        <button type="button">Submit</button>
      </div>
    </>,
  );
  for (const control of [
    screen.getByRole("textbox", { name: "Search" }).element(),
    screen.getByRole("button", { name: "Submit" }).element(),
  ]) {
    if (!(control instanceof HTMLElement)) throw new Error("expected a focusable control");
    control.focus();
    control.dispatchEvent(escape());
  }
  expect(speech.cancel).toHaveBeenCalledTimes(2);
});

it.each([
  ["another editor is recording", false],
  ["the preview itself is recording", true],
])(
  "routes Escape relayed from the preview guest to the preview when %s",
  async (_name, previewRecords) => {
    const composer = previewRecords ? actions(true) : recording();
    const preview = previewRecords ? recording() : actions(true);
    let relayed: DictationKeyHandlers | undefined;
    await using _screen = await render(
      <>
        <Probe speech={composer} />
        <Probe
          speech={preview}
          subscribeKeys={(handlers) => {
            relayed = handlers;
            return () => {};
          }}
        />
      </>,
    );
    relayed?.keydown(escape());
    expect(composer.cancel).not.toHaveBeenCalled();
    expect(preview.cancel).toHaveBeenCalledTimes(previewRecords ? 1 : 0);
  },
);
