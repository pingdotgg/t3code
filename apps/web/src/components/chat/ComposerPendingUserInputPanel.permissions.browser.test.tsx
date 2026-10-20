import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { act, fakeTimers, render } from "../../../test/render";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

it("cancels an answer's pending auto-submit on revocation and resumes after a new grant", async () => {
  using _timers = fakeTimers();
  const onToggleOption = vi.fn();
  const onAdvance = vi.fn();
  const onDismiss = vi.fn();
  const prompt = {
    requestId: RuntimeRequestId.make("scoped-answer"),
    createdAt: "2026-09-05T00:00:00.000Z",
    dismissible: false,
    responseCapability: "live" as const,
    questions: [
      {
        id: "approach",
        header: "Approach",
        question: "Which approach?",
        options: [{ label: "Incremental", description: "One module at a time" }],
        multiSelect: false,
      },
    ],
  };
  const panel = (disabled: boolean) => (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[prompt]}
      cwd="/repo"
      threadRef={threadRef}
      disabled={disabled}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onDismiss={onDismiss}
    />
  );
  await using screen = await render(panel(false));
  // A disabled button swallows the click, as it would for a user.
  const chooseOption = () =>
    [...screen.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Incremental"))!
      .click();
  await act(async () => chooseOption());
  expect(onToggleOption).toHaveBeenCalledWith("approach", "Incremental");
  expect(onAdvance).not.toHaveBeenCalled();

  await screen.rerender(panel(true));
  await act(async () => {
    chooseOption();
    vi.runAllTimers();
  });
  expect(onToggleOption).toHaveBeenCalledTimes(1);
  expect(onAdvance).not.toHaveBeenCalled();

  await screen.rerender(panel(false));
  await act(async () => {
    chooseOption();
    vi.runAllTimers();
  });
  expect(onToggleOption).toHaveBeenCalledTimes(2);
  expect(onAdvance).toHaveBeenCalledTimes(1);
});
