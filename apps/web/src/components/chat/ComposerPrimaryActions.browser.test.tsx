import "~/index.css";

import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("./VoiceInputSetup", () => ({ VoiceInputSetup: () => null }));
vi.mock("~/speech/useEnvironmentSpeechInput", () => ({
  useEnvironmentSpeechInput: vi.fn(),
  useSpeechUnavailableReason: vi.fn(),
}));
vi.mock("~/speech/useDictationShortcut", () => ({ useDictationShortcut: vi.fn() }));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { CollapsedComposerStopAction, ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerSpeechButton } from "./ComposerSpeechButton";
import { TextFieldSpeechControls, type TextFieldSpeech } from "~/speech/useTextFieldSpeech";
import { Button } from "../ui/button";

function setup() {
  return {
    compact: true,
    canOperateThread: true,
    pendingAction: null,
    isRunning: true,
    canInterrupt: true,
    canResume: false,
    isSendBusy: false,
    sendDisabledReason: null,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: false,
    compactBeforeSendTokens: 436_000,
    onToggleKeepFullHistory: vi.fn(),
    onPreviousPendingQuestion: vi.fn(),
    onInterrupt: vi.fn(),
    onResume: vi.fn(),
    onSubmitMessage: vi.fn(),
  } satisfies ComponentProps<typeof ComposerPrimaryActions>;
}

const pressEscape = (element: Element) =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

it.each([false, true])(
  "dictates in the mic's own slot, leaving the pill and the turn's stop alone (running: %s)",
  async (running) => {
    const props = setup();
    const onStop = vi.fn();
    const onCancel = vi.fn();
    const onStart = vi.fn();
    const onSkipPostProcessing = vi.fn();
    const controls = (
      phase: "idle" | "preparing" | "recording" | "transcribing" | "post-processing",
    ) => (
      <ComposerPrimaryActions
        {...props}
        isRunning={running}
        canInterrupt={running}
        voiceInputActive={phase !== "idle"}
        renderSpeechAction={(inPill) => (
          <ComposerSpeechButton
            inPill={inPill}
            state={{ phase, error: null, errorAction: null }}
            shortcutLabel="Ctrl+Alt+V"
            onStart={onStart}
            dictation={{ level: 0.5, onStop, onCancel, onSkipPostProcessing }}
          />
        )}
      />
    );
    const pillButtons = () =>
      [...screen.container.querySelectorAll("[data-composer-send-pill] button")].map(
        (button) => button.getBoundingClientRect().x,
      );
    await using screen = await render(controls("idle"));
    const restingButtons = pillButtons();
    await act(() =>
      (
        screen.getByRole("button", { name: "Start voice input" }).element() as HTMLButtonElement
      ).click(),
    );
    expect(onStart).toHaveBeenCalledOnce();
    await screen.rerender(controls("recording"));
    const mic = screen.getByRole("button", { name: "Finish voice input" }).element();
    expect(mic).toHaveAttribute("aria-pressed", "true");
    expect(screen.container.querySelector('[aria-label="Cancel voice input"]')).toBeNull();
    await act(() => (mic as HTMLButtonElement).click());
    expect(onStop).toHaveBeenCalledOnce();
    expect(props.onInterrupt).not.toHaveBeenCalled();
    for (const phase of ["recording", "preparing", "transcribing", "post-processing"] as const) {
      await screen.rerender(controls(phase));
      expect(pillButtons()).toEqual(restingButtons);
      await pressEscape(screen.container.querySelector("[data-voice-phase]")!);
      if (phase === "preparing" || phase === "transcribing") {
        expect(
          screen
            .getByRole("button", {
              name: phase === "preparing" ? "Preparing voice input" : "Transcribing",
            })
            .element(),
        ).toHaveAttribute("aria-disabled", "true");
      }
      if (running) {
        await expect.element(screen.getByRole("button", { name: "Stop generation" })).toBeEnabled();
      }
    }
    expect(onCancel).toHaveBeenCalledTimes(4);
    expect(onStop).toHaveBeenCalledOnce();
    expect(props.onSubmitMessage).not.toHaveBeenCalled();
    await screen.rerender(controls("post-processing"));
    await act(() =>
      (
        screen.getByRole("button", { name: "Skip post-processing" }).element() as HTMLButtonElement
      ).click(),
    );
    expect(onSkipPostProcessing).toHaveBeenCalledOnce();
    if (running) {
      await act(() =>
        (
          screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
        ).click(),
      );
      expect(props.onInterrupt).toHaveBeenCalledOnce();
      expect(onStop).toHaveBeenCalledOnce();
      await expect
        .element(screen.getByRole("button", { name: "Stopping", exact: true }))
        .toBeDisabled();
    }
  },
);

it("dictates in a text field in place of its mic without moving the buttons beside it", async () => {
  const onStop = vi.fn();
  const onCancel = vi.fn();
  const field = (phase: "idle" | "recording") => (
    <div className="flex w-80 justify-end gap-2">
      <TextFieldSpeechControls
        speech={
          {
            state: { phase, error: null, errorAction: null },
            available: true,
            unavailableReason: null,
            level: 0.5,
            shortcutLabel: null,
            start: vi.fn(),
            stop: onStop,
            cancel: onCancel,
            skipPostProcessing: vi.fn(),
            setup: { open: false },
          } as unknown as TextFieldSpeech
        }
      />
      <Button size="xs">Save</Button>
    </div>
  );
  await using screen = await render(field("idle"));
  const save = screen.getByRole("button", { name: "Save" }).element();
  const restingX = save.getBoundingClientRect().x;
  await screen.rerender(field("recording"));
  expect(save.getBoundingClientRect().x).toBe(restingX);
  expect(screen.container.querySelector('[aria-label="Cancel voice input"]')).toBeNull();
  const mic = screen.getByRole("button", { name: "Finish voice input" }).element();
  await act(() => (mic as HTMLButtonElement).click());
  await pressEscape(mic);
  expect(onStop).toHaveBeenCalledOnce();
  expect(onCancel).toHaveBeenCalledOnce();
});

it.each(["resume", "draft", "question"] as const)(
  "keeps repeat Stop clicks from reaching the action that replaces it (%s)",
  async (mode) => {
    const props = setup();
    const submit = vi.fn();
    const pendingAction =
      mode === "question"
        ? {
            questionIndex: 0,
            isLastQuestion: true,
            canAdvance: true,
            isResponding: false,
            isComplete: true,
          }
        : null;
    const view = (overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {}) => (
      <form
        style={{ display: "flex", justifyContent: "flex-end", width: "400px" }}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <ComposerPrimaryActions {...props} pendingAction={pendingAction} {...overrides} />
      </form>
    );
    await using screen = await render(view());
    using _timers = fakeTimers();
    const stop = screen
      .getByRole("button", { name: "Stop generation" })
      .element() as HTMLButtonElement;
    const { x, y, width, height } = stop.getBoundingClientRect();
    const target = () =>
      document.elementFromPoint(x + width / 2, y + height / 2)?.closest("button");
    await act(() => stop.click());
    await act(() =>
      (
        screen.getByRole("button", { name: "Stopping", exact: true }).element() as HTMLButtonElement
      ).click(),
    );
    expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    await screen.rerender(
      view({
        isRunning: false,
        canInterrupt: false,
        canResume: true,
        hasSendableContent: mode === "draft",
      }),
    );
    const action = { resume: "Resume thread", draft: "Compact and send", question: "Submit" }[mode];
    expect(screen.getByRole("button", { name: "Stop generation" }).query()).toBeNull();
    expect(target()).toBe(screen.getByRole("button", { name: action, exact: true }).element());
    await act(() => {
      for (let i = 0; i < 20; i++) target()?.click();
    });
    await act(() => vi.advanceTimersByTime(499));
    await act(() => target()?.click());
    expect(props.onResume).not.toHaveBeenCalled();
    expect(props.onSubmitMessage).not.toHaveBeenCalled();
    if (mode !== "question") {
      expect(screen.container.querySelectorAll("[data-composer-send-pill]")).toHaveLength(1);
      const compactToggle = screen.container.querySelector<HTMLButtonElement>(
        '[aria-label="Compact 436k tokens of history before sending"]',
      );
      if (mode === "draft") {
        expect(compactToggle).toHaveAttribute("aria-pressed", "true");
        expect(compactToggle?.closest("[data-composer-send-pill]")).toContainElement(
          screen.getByRole("button", { name: action, exact: true }).element(),
        );
        await act(() => compactToggle?.click());
        expect(props.onToggleKeepFullHistory).toHaveBeenCalledOnce();
      } else {
        expect(compactToggle).toBeNull();
      }
    }
    expect(submit).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTime(1));
    await act(() => target()?.click());
    expect(
      { resume: props.onResume, draft: props.onSubmitMessage, question: submit }[mode],
    ).toHaveBeenCalledTimes(1);
    await screen.rerender(view());
    expect(screen.getByRole("button", { name: "Stop generation" }).element()).toBeEnabled();
  },
);

it("allows retry after ten seconds and protects a late stop", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} />);
  using _timers = fakeTimers();
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await act(() => vi.advanceTimersByTime(9_999));
  expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
  await act(() => vi.advanceTimersByTime(1));
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(
    <ComposerPrimaryActions {...props} isRunning={false} canInterrupt={false} canResume />,
  );
  await act(() =>
    (screen.getByRole("button", { name: "Resume thread" }).element() as HTMLButtonElement).click(),
  );
  expect(props.onInterrupt).toHaveBeenCalledTimes(2);
  expect(props.onResume).not.toHaveBeenCalled();
});

it("keeps Stop pending across a permission failure", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} />);
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(
    <ComposerPrimaryActions {...props} canOperateThread={false} canInterrupt={false} />,
  );
  await screen.rerender(<ComposerPrimaryActions {...props} />);
  await expect
    .element(screen.getByRole("button", { name: "Stopping", exact: true }))
    .toBeDisabled();
  expect(props.onInterrupt).toHaveBeenCalledTimes(1);
});

it("keeps a pending stop when the run id clears and resets it for a different run", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} runId="first" />);
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(<ComposerPrimaryActions {...props} runId={null} />);
  expect(screen.getByRole("button", { name: "Stopping", exact: true }).element()).toBeDisabled();
  await screen.rerender(<ComposerPrimaryActions {...props} runId="second" />);
  expect(screen.getByRole("button", { name: "Stop generation" }).element()).toBeEnabled();
});

it("swaps the collapsed composer's send button for Stop while a turn can be stopped", async () => {
  const onInterrupt = vi.fn();
  const collapsed = (overrides: { canInterrupt?: boolean; hasSendableContent?: boolean } = {}) => (
    <CollapsedComposerStopAction
      canOperateThread
      canInterrupt={overrides.canInterrupt ?? true}
      runId="run"
      hasSendableContent={overrides.hasSendableContent ?? false}
      isEditingQueuedMessage={false}
      onInterrupt={onInterrupt}
    >
      <button type="button">Send message</button>
    </CollapsedComposerStopAction>
  );
  await using screen = await render(collapsed({ hasSendableContent: true }));
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
  await screen.rerender(collapsed());
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  await expect
    .element(screen.getByRole("button", { name: "Stopping", exact: true }))
    .toBeDisabled();
  await screen.rerender(collapsed({ canInterrupt: false }));
  await expect.element(screen.getByRole("button", { name: "Send message" })).toBeVisible();
});
