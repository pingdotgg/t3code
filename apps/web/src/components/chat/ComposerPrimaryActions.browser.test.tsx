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

function setup() {
  return {
    compact: true,
    canOperateThread: true,
    pendingAction: null,
    isRunning: true,
    canInterrupt: true,
    canResume: false,
    showPlanFollowUpPrompt: false,
    promptHasText: false,
    isSendBusy: false,
    sendDisabledReason: null,
    isEnvironmentUnavailable: false,
    isPreparingWorktree: false,
    hasSendableContent: false,
    onPreviousPendingQuestion: vi.fn(),
    onInterrupt: vi.fn(),
    onResume: vi.fn(),
    onSubmitMessage: vi.fn(),
    onImplementPlanInNewThread: vi.fn(),
  } satisfies ComponentProps<typeof ComposerPrimaryActions>;
}

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
        promptHasText={draft}
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
    const action = screen
      .getByRole("button", { name: draft ? "Submit message" : "Resume thread" })
      .element() as HTMLButtonElement;
    await act(() => action.click());
    expect(draft ? props.onSubmitMessage : props.onResume).toHaveBeenCalledTimes(1);
    await screen.rerender(<ComposerPrimaryActions {...props} />);
    await expect.element(screen.getByRole("button", { name: "Stop generation" })).toBeEnabled();
  },
);

it.each([false, true])(
  "allows retry after ten seconds and protects a late stop (retry: %s)",
  async (retry) => {
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
    expect(screen.getByRole("button", { name: "Stop generation" }).element()).toBeEnabled();
    if (retry)
      await act(() =>
        (
          screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
        ).click(),
      );
    await screen.rerender(
      <ComposerPrimaryActions {...props} isRunning={false} canInterrupt={false} canResume />,
    );
    expect(screen.getByRole("button", { name: "Stopped", exact: true }).element()).toBeDisabled();
    expect(props.onInterrupt).toHaveBeenCalledTimes(retry ? 2 : 1);
    expect(props.onResume).not.toHaveBeenCalled();
  },
);

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

it("clears a pending stop when reconnect skips straight to a different run", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} {...{ runId: "first" }} />);
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(<ComposerPrimaryActions {...props} {...{ runId: "second" }} />);
  expect(screen.getByRole("button", { name: "Stop generation" }).element()).toBeEnabled();
});

it("retains the stopped target when the executing run finishes", async () => {
  const props = setup();
  await using screen = await render(<ComposerPrimaryActions {...props} runId="executing" />);
  await act(() =>
    (
      screen.getByRole("button", { name: "Stop generation" }).element() as HTMLButtonElement
    ).click(),
  );
  await screen.rerender(
    <ComposerPrimaryActions
      {...props}
      runId={null}
      canInterrupt={false}
      isRunning={false}
      canResume
    />,
  );
  expect(screen.getByRole("button", { name: "Stopped", exact: true }).element()).toBeDisabled();
});
