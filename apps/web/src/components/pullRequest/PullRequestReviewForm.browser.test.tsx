import { createRef } from "react";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

const mocks = vi.hoisted(() => ({
  submit: vi.fn().mockResolvedValue({ _tag: "Success" }),
  queue: vi.fn<(submit: (text: string) => void) => void>(),
  viewer: null as string | null,
}));
vi.mock("~/speech/useTextFieldSpeech", () => ({
  TextFieldSpeechControls: () => null,
  useTextFieldSpeech: () => ({ blocksSubmission: true, submitAfterDictation: mocks.queue }),
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: mocks.viewer === null ? undefined : { viewer: mocks.viewer },
    error: null,
  })) as never,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.submit }));
vi.mock("./usePendingReviewCommentActions", () => ({
  usePendingReviewCommentActions: () => ({ busy: false }),
}));
vi.mock("./PullRequestAttachments", () => ({ PullRequestAttachments: () => null }));

function setup() {
  mocks.viewer = null;
  mocks.submit.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.queue.mockReset();
}

it("submits only the line comments still in the draft when dictation finishes", async () => {
  setup();
  const reference = { projectId: ProjectId.make("test"), repository: "test/repo", number: 1 };
  const key = pullRequestReviewKey(reference, {
    environmentId: EnvironmentId.make("test"),
    viewer: "current-account",
  });
  const store = usePullRequestReviewStore.getState();
  store.clear(key);
  store.setSummary(
    pullRequestReviewKey(reference, {
      environmentId: EnvironmentId.make("test"),
      viewer: undefined,
    }),
    "Unowned legacy summary",
  );
  store.addComment(key, {
    id: "removed",
    body: "Do not post",
    path: "a.ts",
    position: { kind: "added", newLine: 1 },
  });
  const form = () => (
    <PullRequestReviewForm
      active
      reviewThreads={[
        {
          id: "hosted-thread",
          path: "hosted.ts",
          line: 2,
          side: "right",
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: "hosted-comment",
              body: "Saved on GitHub",
              url: "https://github.com/test/repo/pull/1#discussion_r1",
              author: null,
              createdAt: "2026-11-12T00:00:00Z",
              pendingReviewId: "pending-review",
            },
          ],
        },
      ]}
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
    />
  );
  await using screen = await render(form());
  await expect.element(screen.getByRole("textbox", { name: "Review summary" })).toBeDisabled();
  await expect.element(screen.getByRole("textbox", { name: "Review summary" })).toHaveValue("");
  await expect.element(screen.getByRole("button", { name: "Submit review" })).toBeDisabled();
  mocks.viewer = "current-account";
  await screen.rerender(form());
  await expect.element(screen.getByRole("textbox", { name: "Review summary" })).toBeEnabled();
  await screen.getByRole("button", { name: "Submit review" }).click();
  await act(() => store.clear(key));
  await act(() => mocks.queue.mock.calls[0]![0]("Dictated summary"));
  expect(mocks.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        body: "Dictated summary",
        pendingReviewId: "pending-review",
        comments: [
          expect.objectContaining({
            id: "hosted-comment",
            body: "Saved on GitHub",
            hostedComment: {
              reviewId: "pending-review",
              commentId: "hosted-comment",
              url: "https://github.com/test/repo/pull/1#discussion_r1",
            },
          }),
        ],
      }),
    }),
  );
});
