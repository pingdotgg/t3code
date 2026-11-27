import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { createRef, type RefObject, useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { useDictationShortcut, type DictationKeyHandlers } from "./useDictationShortcut";
import { useDictationSubmissionShortcut } from "./useDictationSubmissionShortcut";

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

it.each([
  { mode: "hold", heldMs: 0, stops: 1 },
  { mode: "auto", heldMs: 300, stops: 1 },
  { mode: "auto", heldMs: 299, stops: 0 },
] as const)(
  "ends a $mode press held $heldMs ms when a chord modifier is released without the letter keyup",
  async ({ mode, heldMs, stops }) => {
    const speech = actions(true, mode);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    await using _screen = await render(<Probe speech={speech} />);
    using clock = vi.spyOn(performance, "now").mockReturnValue(0);
    press();
    clock.mockReturnValue(heldMs);
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", code: "AltLeft" }));
    await speech.start.mock.results[0]?.value;
    expect(speech.stop).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta", code: "MetaLeft" }));
    await speech.start.mock.results[0]?.value;
    expect(speech.stop).toHaveBeenCalledTimes(stops);
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

it("lets Escape close a modal opened over the recording before canceling it", async () => {
  const speech = recording();
  const closeImage = vi.fn();
  await using screen = await render(
    <>
      <Probe speech={speech} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Expanded image"
        onKeyDown={(event) => {
          if (event.key === "Escape") closeImage();
        }}
      >
        <button type="button">Close</button>
      </div>
    </>,
  );
  const close = screen.getByRole("button", { name: "Close" }).element();
  if (!(close instanceof HTMLElement)) throw new Error("expected the image dialog's button");
  close.focus();
  close.dispatchEvent(escape());
  expect(speech.cancel).not.toHaveBeenCalled();
  expect(closeImage).toHaveBeenCalledTimes(1);
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

function SubmissionProbe({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const formRef = useRef<HTMLFormElement>(null);
  useDictationSubmissionShortcut({ enabled: true, formRef, onKeyDown });
  return (
    <>
      <div data-testid="timeline" tabIndex={0}>
        <button type="button">Copy</button>
        <input aria-label="Search" />
      </div>
      <form ref={formRef} />
    </>
  );
}

it("submits dictation on Enter while the chat timeline has focus", async () => {
  const onKeyDown = vi.fn();
  await using screen = await render(<SubmissionProbe onKeyDown={onKeyDown} />);
  (screen.getByTestId("timeline").element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(onKeyDown).toHaveBeenCalledOnce();
});

it("leaves dictation Enter to a focused button or field", async () => {
  const onKeyDown = vi.fn();
  await using screen = await render(<SubmissionProbe onKeyDown={onKeyDown} />);
  (screen.getByRole("button", { name: "Copy" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  (screen.getByRole("textbox", { name: "Search" }).element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  expect(onKeyDown).not.toHaveBeenCalled();
});
