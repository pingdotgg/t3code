import { createRef } from "react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

const mocks = vi.hoisted(() => ({
  submit: vi.fn().mockResolvedValue({ _tag: "Success" }),
  queue: vi.fn<(submit: (text: string) => void) => void>(),
}));
vi.mock("~/speech/useTextFieldSpeech", () => ({
  TextFieldSpeechControls: () => null,
  useTextFieldSpeech: () => ({ blocksSubmission: true, submitAfterDictation: mocks.queue }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.submit }));
vi.mock(import("~/state/pullRequests"), async (original) => ({
  ...(await original()),
  pullRequestEnvironment: { submitReview: {} } as never,
}));

it("submits only the line comments still in the draft when dictation finishes", async () => {
  mocks.submit.mockClear();
  mocks.queue.mockClear();
  const reference = { projectId: ProjectId.make("test"), repository: "test/repo", number: 1 };
  const key = pullRequestReviewKey(reference);
  const store = usePullRequestReviewStore.getState();
  store.clear(key);
  store.addComment(key, {
    id: "removed",
    body: "Do not post",
    path: "a.ts",
    position: { kind: "added", newLine: 1 },
  });
  await using screen = await render(
    <PullRequestReviewForm
      active
      environmentId={EnvironmentId.make("test")}
      reference={reference}
      completionScope={null}
      term="pull request"
      verdicts={["comment"]}
      requestChangesSummaryRequired={false}
      textareaRef={createRef()}
      pending={false}
      onPendingChange={vi.fn()}
      onSubmitted={vi.fn()}
    />,
  );
  await screen.getByRole("button", { name: "Submit review" }).click();
  await act(() => store.clear(key));
  await act(() => mocks.queue.mock.calls[0]![0]("Dictated summary"));
  expect(mocks.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ body: "Dictated summary", comments: [] }),
    }),
  );
});
