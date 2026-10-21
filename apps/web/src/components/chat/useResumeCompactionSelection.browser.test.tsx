import "~/index.css";

import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { IdleCompactionMode } from "@t3tools/contracts";

vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: () => null,
  useSidebarStageBackdropVariant: () => null,
}));

import { act, render } from "../../../test/render";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { useResumeCompactionSelection } from "./useResumeCompactionSelection";

function ResumeCompactionActions(props: {
  mode: IdleCompactionMode;
  threadKey?: string;
  sendMessage?: () => Promise<void>;
}) {
  const threadKey = props.threadKey ?? "thread-1";
  const { keepFullHistory, setKeepFullHistory, defaultKeepFullHistory } =
    useResumeCompactionSelection(props.mode, threadKey);
  return (
    <ComposerPrimaryActions
      compact={false}
      canOperateThread
      pendingAction={null}
      isRunning={false}
      canInterrupt={false}
      showPlanFollowUpPrompt={false}
      promptHasText
      isSendBusy={false}
      sendDisabledReason={null}
      isConnecting={false}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={() => {}}
      compactBeforeSendTokens={props.mode === "off" ? null : 250_000}
      keepFullHistory={keepFullHistory}
      onToggleKeepFullHistory={() => setKeepFullHistory(!keepFullHistory)}
      onSubmitMessage={async () => {
        await props.sendMessage?.();
        setKeepFullHistory(defaultKeepFullHistory);
      }}
    />
  );
}

const compactionChip = () =>
  page.getByRole("button", { name: "Compact 250k tokens of history before sending" });

it("preserves independent choices across threads with different provider modes", async () => {
  await using screen = await render(<ResumeCompactionActions mode="suggestOnReturn" />);
  await userEvent.click(compactionChip());

  await screen.rerender(<ResumeCompactionActions mode="onReturn" threadKey="thread-2" />);
  await userEvent.click(compactionChip());
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "false");

  await screen.rerender(<ResumeCompactionActions mode="suggestOnReturn" />);
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "true");
  await screen.rerender(<ResumeCompactionActions mode="onReturn" threadKey="thread-2" />);
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "false");
});

it("resets only the sending thread when it finishes after switching threads", async () => {
  let completeSend!: () => void;
  const pendingSend = new Promise<void>((resolve) => {
    completeSend = resolve;
  });
  const sendMessage = () => pendingSend;
  await using screen = await render(
    <ResumeCompactionActions mode="suggestOnReturn" sendMessage={sendMessage} />,
  );
  await userEvent.click(compactionChip());
  await userEvent.click(page.getByRole("button", { name: "Compact and send" }));

  await screen.rerender(<ResumeCompactionActions mode="onReturn" threadKey="thread-2" />);
  await userEvent.click(compactionChip());
  await act(() => completeSend());
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "false");

  await screen.rerender(<ResumeCompactionActions mode="suggestOnReturn" />);
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "false");
});

it("preserves a new manual opt-in made while an earlier send is pending", async () => {
  let completeSend!: () => void;
  const pendingSend = new Promise<void>((resolve) => {
    completeSend = resolve;
  });
  await using screen = await render(
    <ResumeCompactionActions mode="suggestOnReturn" sendMessage={() => pendingSend} />,
  );
  await userEvent.click(screen.getByRole("button", { name: "Submit message" }));
  await userEvent.click(compactionChip());
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "true");

  await act(() => completeSend());
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "true");
});

it.each(["onReturn", "suggestOnReturn", "beforeCacheExpires"] as const)(
  "uses the %s default, allows an override, and restores the default after sending",
  async (mode) => {
    await using _screen = await render(<ResumeCompactionActions mode={mode} />);
    const selected = mode !== "suggestOnReturn";
    await expect.element(compactionChip()).toHaveAttribute("aria-pressed", String(selected));
    await expect
      .element(page.getByRole("button", { name: selected ? "Compact and send" : "Submit message" }))
      .toBeVisible();

    await userEvent.click(compactionChip());
    await expect.element(compactionChip()).toHaveAttribute("aria-pressed", String(!selected));
    await userEvent.click(
      page.getByRole("button", { name: selected ? "Submit message" : "Compact and send" }),
    );
    await expect.element(compactionChip()).toHaveAttribute("aria-pressed", String(selected));
  },
);

it("keeps overrides local to each thread and clears them when the mode changes", async () => {
  await using screen = await render(<ResumeCompactionActions mode="suggestOnReturn" />);
  await userEvent.click(compactionChip());
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "true");

  await screen.rerender(<ResumeCompactionActions mode="suggestOnReturn" threadKey="thread-2" />);
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "false");
  await screen.rerender(<ResumeCompactionActions mode="suggestOnReturn" />);
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "true");

  await screen.rerender(<ResumeCompactionActions mode="off" />);
  await expect.element(compactionChip()).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Submit message" })).toBeVisible();
  await screen.rerender(<ResumeCompactionActions mode="suggestOnReturn" />);
  await expect.element(compactionChip()).toHaveAttribute("aria-pressed", "false");
});

it.each(["onReturn", "suggestOnReturn"] as const)(
  "preserves a newer override when a pending send spans an %s mode round trip",
  async (mode) => {
    let completeSend!: () => void;
    const pendingSend = new Promise<void>((resolve) => {
      completeSend = resolve;
    });
    const sendMessage = () => pendingSend;
    await using screen = await render(
      <ResumeCompactionActions mode={mode} sendMessage={sendMessage} />,
    );

    await userEvent.click(
      page.getByRole("button", {
        name: mode === "onReturn" ? "Compact and send" : "Submit message",
      }),
    );
    await screen.rerender(
      <ResumeCompactionActions
        mode={mode === "onReturn" ? "suggestOnReturn" : "onReturn"}
        sendMessage={sendMessage}
      />,
    );
    await screen.rerender(<ResumeCompactionActions mode={mode} sendMessage={sendMessage} />);
    await userEvent.click(compactionChip());
    await expect
      .element(compactionChip())
      .toHaveAttribute("aria-pressed", String(mode !== "onReturn"));

    await act(() => completeSend());
    await expect
      .element(compactionChip())
      .toHaveAttribute("aria-pressed", String(mode !== "onReturn"));
  },
);
