import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const submitReview = vi.hoisted(() => vi.fn());
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => submitReview }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: {} }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("./PullRequestMarkdown", () => ({
  PullRequestMarkdown: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("./PullRequestMarkdownField", () => ({ PullRequestMarkdownField: () => null }));

import { PendingReviewCommentCard } from "./PullRequestReviewAnnotation";
import { PullRequestReviewBar } from "./PullRequestReviewBar";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

const reference = { projectId: ProjectId.make("project"), repository: "owner/repo", number: 1 };
const key = pullRequestReviewKey(reference);
let renderer: ReactTestRenderer;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  usePullRequestReviewStore.setState({
    drafts: {},
    summaries: {},
    editingComments: {},
    submittingReviews: {},
  });
  submitReview.mockReset().mockResolvedValue({ _tag: "Success" });
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
});

it("blocks review submission until an open pending-comment editor finishes", async () => {
  const store = usePullRequestReviewStore.getState();
  store.addComment(key, {
    id: "pending",
    body: "Original",
    path: "file.ts",
    position: { kind: "added", newLine: 1 },
  });
  store.setCommentEditing(key, "pending", true);
  await act(async () => {
    renderer = create(
      <PullRequestReviewBar
        environmentId={EnvironmentId.make("env")}
        reference={reference}
        verdicts={["comment"]}
        requestChangesSummaryRequired={false}
        onSubmitted={() => {}}
      />,
    );
  });
  const button = () =>
    renderer.root.findAllByType("button").find((node) => node.props.variant === "outline")!;
  expect(button().props.disabled).toBe(true);
  await act(async () => {
    button().props.onClick();
  });
  expect(submitReview).not.toHaveBeenCalled();
  await act(async () => {
    usePullRequestReviewStore.getState().updateComment(key, "pending", "Updated with attachment");
    usePullRequestReviewStore.getState().setCommentEditing(key, "pending", false);
  });
  expect(button().props.disabled).toBe(false);
  await act(async () => {
    button().props.onClick();
  });
  expect(submitReview).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        comments: [expect.objectContaining({ body: "Updated with attachment" })],
      }),
    }),
  );
});

it.each(["Success", "Failure", "throw"])(
  "blocks opening a pending editor during submit and releases it after %s",
  async (outcome) => {
    const store = usePullRequestReviewStore.getState();
    const comment = {
      id: "pending",
      body: "Original",
      path: "file.ts",
      position: { kind: "added", newLine: 1 },
    } as const;
    store.addComment(key, comment);
    let finish!: (result: { _tag: string }) => void;
    let reject!: (error: Error) => void;
    submitReview.mockImplementation(
      () =>
        new Promise((resolve, fail) => {
          finish = resolve;
          reject = fail;
        }),
    );
    await act(async () => {
      renderer = create(
        <>
          <PendingReviewCommentCard
            comment={comment}
            reviewKey={key}
            environmentId={EnvironmentId.make("env")}
            workspaceRoot="/workspace"
            pending={false}
            onRemove={() => store.removeComment(key, comment.id)}
            onEdit={(body) => store.updateComment(key, comment.id, body)}
          />
          <PullRequestReviewBar
            environmentId={EnvironmentId.make("env")}
            reference={reference}
            verdicts={["comment"]}
            requestChangesSummaryRequired={false}
            onSubmitted={() => {}}
          />
        </>,
      );
    });
    const edit = () =>
      renderer.root.findAllByType("button").find((node) => node.children.includes("Edit"))!;
    const submit = renderer.root
      .findAllByType("button")
      .find((node) => node.props.variant === "outline")!;
    await act(async () => {
      submit.props.onClick();
      edit().props.onClick();
      submit.props.onClick();
    });
    expect(submitReview).toHaveBeenCalledOnce();
    expect(edit().props.disabled).toBe(true);
    expect(renderer.root.findByProps({ "aria-label": "Discard this comment" }).props.disabled).toBe(
      true,
    );
    expect(usePullRequestReviewStore.getState().editingComments[key]).toBeUndefined();
    expect(usePullRequestReviewStore.getState().submittingReviews[key]).toBe(true);
    await act(async () => {
      if (outcome === "throw") reject(new Error("Network unavailable"));
      else finish({ _tag: outcome });
    });
    expect(usePullRequestReviewStore.getState().submittingReviews[key]).toBeUndefined();
    expect(edit().props.disabled).toBe(false);
    expect(usePullRequestReviewStore.getState().drafts[key]).toEqual(
      outcome === "Success" ? undefined : [comment],
    );
  },
);
