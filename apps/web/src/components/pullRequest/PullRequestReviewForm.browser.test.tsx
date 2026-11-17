import { Atom } from "effect/reactivity";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { attachmentEnvironment } from "~/state/attachments";
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
  publish: vi.fn(),
}));
vi.mock("~/speech/useTextFieldSpeech", () => ({
  TextFieldSpeechControls: () => null,
  useTextFieldSpeech: () => ({ blocksSubmission: true, submitAfterDictation: mocks.queue }),
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data:
      mocks.viewer === null
        ? undefined
        : {
            viewer: mocks.viewer,
            capabilities: { attachments: true },
            viewerPermissions: { attachments: true },
          },
    error: null,
  })) as never,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.submit }));
vi.mock("./usePendingReviewCommentActions", () => ({
  usePendingReviewCommentActions: () => ({ busy: false }),
}));
vi.mock("@t3tools/client-runtime/review-attachments", () => ({
  publishReviewAttachment: mocks.publish,
}));

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

it("keeps the summary when readiness is lost during an attachment upload", async () => {
  setup();
  mocks.viewer = "current-account";
  let finish!: (markdown: string) => void;
  mocks.publish.mockReset().mockReturnValue(
    new Promise<string>((resolve) => {
      finish = resolve;
    }),
  );
  const reference = { projectId: ProjectId.make("upload"), repository: "test/repo", number: 2 };
  const environmentId = EnvironmentId.make("upload");
  const key = pullRequestReviewKey(reference, { environmentId, viewer: "current-account" });
  const store = usePullRequestReviewStore.getState();
  store.clear(key);
  store.setSummary(key, "Original feedback");
  using _publish = vi
    .spyOn(pullRequestEnvironment.uploadAttachment, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  using _transfer = vi
    .spyOn(attachmentEnvironment.createUploadUrl, "permissionAtom")
    .mockReturnValue(Atom.make(true));
  const form = () => (
    <PullRequestReviewForm
      active
      reviewThreads={[]}
      environmentId={environmentId}
      reference={reference}
      completionScope={null}
      term="pull request"
      verdicts={["comment"]}
      requestChangesSummaryRequired={false}
      textareaRef={createRef()}
      pending={false}
      onPendingChange={() => {}}
      onSubmitted={() => {}}
    />
  );
  await using screen = await render(form());
  const textarea = screen.container.querySelector("textarea")!;
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  const input = screen.container.querySelector('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    value: [new File(["image"], "screen.png", { type: "image/png" })],
  });
  await act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(mocks.publish).toHaveBeenCalledOnce();
  mocks.viewer = null;
  await screen.rerender(form());
  await act(() => finish("![screen](https://example.com/screen.png)"));
  expect(usePullRequestReviewStore.getState().summaries[key]).toBe("Original feedback");
});
