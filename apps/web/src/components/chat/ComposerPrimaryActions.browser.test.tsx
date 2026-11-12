import "~/index.css";

import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
  useClientSettings: () => false,
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerSpeechButton } from "./ComposerSpeechButton";

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

it.each([false, true])(
  "keeps dictation finish, cancel and turn stop separate (running: %s)",
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
        hasSendableContent={phase !== "idle"}
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
    await using screen = await render(controls("idle"));
    await act(() =>
      (
        screen.getByRole("button", { name: "Start voice input" }).element() as HTMLButtonElement
      ).click(),
    );
    expect(onStart).toHaveBeenCalledOnce();
    await screen.rerender(controls("recording"));
    expect(screen.container.querySelectorAll('[aria-label="Finish voice input"]')).toHaveLength(1);
    expect(screen.container.querySelector('[aria-label="Stop voice input"]')).toBeNull();
    await act(() =>
      (
        screen.getByRole("button", { name: "Finish voice input" }).element() as HTMLButtonElement
      ).click(),
    );
    expect(onStop).toHaveBeenCalledOnce();
    expect(props.onInterrupt).not.toHaveBeenCalled();
    for (const phase of ["recording", "preparing", "transcribing", "post-processing"] as const) {
      await screen.rerender(controls(phase));
      expect(screen.container.querySelector('[aria-label^="Compact 436k"]')).toBeNull();
      expect(screen.container.querySelectorAll("[data-composer-send-pill]")).toHaveLength(1);
      await act(() =>
        (
          screen.getByRole("button", { name: "Cancel voice input" }).element() as HTMLButtonElement
        ).click(),
      );
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
      await expect
        .element(screen.getByRole("button", { name: "Stopping", exact: true }))
        .toBeDisabled();
      await expect
        .element(screen.getByRole("button", { name: "Cancel voice input" }))
        .toBeEnabled();
    }
  },
);

it.each([false, true])(
  "keeps repeat clicks away from Resume and Send (draft: %s)",
  async (draft) => {
    const props = setup();
    const container = document.createElement("div");
    Object.assign(container.style, { display: "flex", justifyContent: "flex-end", width: "400px" });
    await using screen = await render(<ComposerPrimaryActions {...props} />, { container });
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
    await expect
      .element(screen.getByRole("button", { name: "Stopping", exact: true }))
      .toBeDisabled();
    expect(props.onInterrupt).toHaveBeenCalledTimes(1);
    await screen.rerender(
      <ComposerPrimaryActions
        {...props}
        isRunning={false}
        canInterrupt={false}
        canResume
        hasSendableContent={draft}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Stopped", exact: true }))
      .toBeDisabled();
    expect(target()).toHaveAttribute("aria-label", "Stopped");
    await act(() => {
      for (let i = 0; i < 20; i++) target()?.click();
    });
    expect(props.onResume).not.toHaveBeenCalled();
    expect(props.onSubmitMessage).not.toHaveBeenCalled();
    expect(screen.container.querySelectorAll("[data-composer-send-pill]")).toHaveLength(1);
    const compactToggle = screen.container.querySelector<HTMLButtonElement>(
      '[aria-label="Compact 436k tokens of history before sending"]',
    );
    if (draft) {
      expect(compactToggle).toHaveAttribute("aria-pressed", "true");
      expect(compactToggle?.closest("[data-composer-send-pill]")).toContainElement(
        screen.getByRole("button", { name: "Stopped", exact: true }).element(),
      );
      await act(() => compactToggle?.click());
      expect(props.onToggleKeepFullHistory).toHaveBeenCalledOnce();
    } else {
      expect(compactToggle).toBeNull();
    }
    const action = screen
      .getByRole("button", { name: draft ? "Compact and send" : "Resume thread" })
      .element() as HTMLButtonElement;
    await act(() => action.click());
    expect(draft ? props.onSubmitMessage : props.onResume).toHaveBeenCalledTimes(1);
    await screen.rerender(<ComposerPrimaryActions {...props} />);
    await expect.element(screen.getByRole("button", { name: "Stop generation" })).toBeEnabled();
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
  expect(screen.getByRole("button", { name: "Stopped", exact: true }).element()).toBeDisabled();
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
