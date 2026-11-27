import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId, type PullRequestRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { readPendingWorkspaceDefault } from "~/lib/draftWorkspaceDefaults";
import { ToastProvider } from "../ui/toast";
import { usePullRequestActionRunner, usePullRequestHandoffs } from "./usePullRequestActions";

const state = vi.hoisted(() => ({
  runAction: vi.fn(),
  newThread: vi.fn(),
  prepareThread: vi.fn(),
}));
vi.mock(import("~/state/use-atom-command"), () => ({
  useAtomCommand: (() => state.runAction) as never,
}));
vi.mock(import("~/hooks/useHandleNewThread"), () => ({
  useNewThreadHandler: (() => state.newThread) as never,
}));
vi.mock(import("~/state/sourceControlActions"), () => ({
  usePreparePullRequestThreadAction: (() => ({ run: state.prepareThread })) as never,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function MergeButton({ reference }: { reference: PullRequestRef }) {
  const { actionPending, pendingAction, perform } = usePullRequestActionRunner({
    environmentId: EnvironmentId.make("environment"),
    reference,
    headSha: `head-${reference.number}`,
    terminology: sourceControlClients.get(undefined).changeRequest,
  });
  return (
    <button type="button" disabled={actionPending} onClick={() => void perform("merge")}>
      {pendingAction === "merge" ? "Merging..." : "Merge"}
    </button>
  );
}

function setup() {
  state.runAction.mockReset();
  state.newThread.mockReset();
  state.prepareThread.mockReset();
}

it("keeps pending merges with their pull request when navigating between threads", async () => {
  setup();
  const first: PullRequestRef = {
    projectId: ProjectId.make("project"),
    repository: "owner/repo",
    number: 1,
  };
  const second = { ...first, number: 2 };
  const firstResult = deferred<{ _tag: "Success"; value: void }>();
  const secondResult = deferred<{ _tag: "Success"; value: void }>();
  state.runAction
    .mockReturnValueOnce(firstResult.promise)
    .mockReturnValueOnce(secondResult.promise);
  await using screen = await render(<MergeButton reference={first} />);
  const button = screen.getByRole("button");

  await userEvent.click(button);
  await expect.element(button).toHaveTextContent("Merging...");
  await screen.rerender(
    <MergeButton reference={{ ...first, projectId: ProjectId.make("other-project") }} />,
  );
  await expect.element(button).toHaveTextContent("Merge");
  await expect.element(button).toBeEnabled();
  await screen.rerender(<MergeButton reference={first} />);
  await expect.element(button).toHaveTextContent("Merging...");
  await expect.element(button).toBeDisabled();
  await screen.rerender(<MergeButton reference={second} />);
  await expect.element(button).toHaveTextContent("Merge");
  await expect.element(button).toBeEnabled();
  await userEvent.click(button);
  expect(state.runAction).toHaveBeenCalledTimes(2);
  // Each merge is pinned to the head its own row showed.
  expect(state.runAction.mock.calls.map(([call]) => call.input.expectedHeadSha)).toEqual([
    "head-1",
    "head-2",
  ]);

  await screen.rerender(<MergeButton reference={first} />);
  await expect.element(button).toHaveTextContent("Merging...");
  await expect.element(button).toBeDisabled();
  await act(async () => {
    firstResult.resolve({ _tag: "Success", value: undefined });
    await firstResult.promise;
  });
  await expect.element(button).toHaveTextContent("Merge");
  await screen.rerender(<MergeButton reference={second} />);
  await expect.element(button).toHaveTextContent("Merging...");
  await act(async () => {
    secondResult.resolve({ _tag: "Success", value: undefined });
    await secondResult.promise;
  });
  await expect.element(button).toHaveTextContent("Merge");
});

function FixChecksButton() {
  const { startHandoff } = usePullRequestHandoffs({
    environmentId: EnvironmentId.make("environment"),
    detail: {
      projectId: ProjectId.make("project"),
      workspaceRoot: "/repo",
      url: "https://github.com/owner/repo/pull/1",
    },
  });
  return (
    <button type="button" onClick={() => void startHandoff("fix", { prompt: "Fix the checks" })}>
      Fix
    </button>
  );
}

it("stops a pull request handoff when its loading toast is dismissed", async () => {
  setup();
  const prepared = deferred<{
    _tag: "Success";
    value: {
      branch: string;
      worktreePath: string;
      isOnPullRequestHead: boolean;
      pullRequest: { url: string };
    };
  }>();
  state.newThread
    .mockResolvedValueOnce({ draftId: "draft-1", threadId: ThreadId.make("thread-1") })
    .mockResolvedValueOnce({ draftId: "draft-2", threadId: ThreadId.make("thread-1") });
  state.prepareThread.mockReturnValueOnce(prepared.promise);
  await using screen = await render(
    <ToastProvider>
      <FixChecksButton />
    </ToastProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Fix" }));
  const toast = screen.getByRole("dialog", { name: "Preparing the pull request checkout..." });
  await expect.element(toast).toBeVisible();
  await userEvent.click(toast.getByRole("button", { name: "Dismiss notification" }));
  await expect.element(toast).not.toBeInTheDocument();
  await act(async () => {
    prepared.resolve({
      _tag: "Success",
      value: {
        branch: "pr-1",
        worktreePath: "/repo-worktrees/pr-1",
        isOnPullRequestHead: true,
        pullRequest: { url: "https://github.com/owner/repo/pull/1" },
      },
    });
    await prepared.promise;
  });

  expect(state.newThread).toHaveBeenCalledTimes(1);
  expect(useComposerDraftStore.getState().getComposerDraft("draft-2" as never)?.prompt ?? "").toBe(
    "",
  );
});

function CheckOutButton({
  number = 1,
  label = "Check out",
  prompt,
}: {
  number?: number;
  label?: string;
  prompt?: string;
}) {
  const { handoff, startHandoff } = usePullRequestHandoffs({
    environmentId: EnvironmentId.make("environment"),
    detail: {
      projectId: ProjectId.make("project"),
      workspaceRoot: "/repo",
      url: `https://github.com/owner/repo/pull/${number}`,
    },
  });
  return (
    <button
      type="button"
      disabled={handoff !== null}
      onClick={() => void startHandoff("checkout", prompt === undefined ? null : { prompt })}
    >
      {label}
    </button>
  );
}

it("clears a superseded checkout without adding its task to the draft", async () => {
  setup();
  const draftId = DraftId.make("shared-checkout-draft");
  const threadId = ThreadId.make("shared-checkout-thread");
  state.newThread.mockImplementation(async (projectRef) => {
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
        threadId,
      });
    return { draftId, threadId };
  });
  const success = (number: number) => ({
    _tag: "Success" as const,
    value: {
      branch: `pr-${number}`,
      worktreePath: `/repo-worktrees/pr-${number}`,
      isOnPullRequestHead: true,
      pullRequest: { url: `https://github.com/owner/repo/pull/${number}` },
    },
  });
  const first = deferred<ReturnType<typeof success>>();
  const second = deferred<ReturnType<typeof success>>();
  state.prepareThread.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  await using screen = await render(
    <ToastProvider>
      <CheckOutButton label="First checkout" prompt="Review the first pull request" />
      <CheckOutButton number={2} label="Second checkout" />
    </ToastProvider>,
  );
  const firstButton = screen.getByRole("button", { name: "First checkout" });
  const secondButton = screen.getByRole("button", { name: "Second checkout" });
  await userEvent.click(firstButton);
  await userEvent.click(secondButton);
  await expect.element(secondButton).toBeDisabled();

  await act(async () => first.resolve(success(1)));

  await expect.element(firstButton).toBeEnabled();
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt ?? "").toBe("");

  await act(async () => second.resolve(success(2)));

  await expect.element(screen.getByRole("dialog", { name: "Checked out" })).toBeVisible();
  await expect
    .element(screen.getByRole("dialog", { name: "Preparing the pull request checkout..." }))
    .not.toBeInTheDocument();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.branch).toBe("pr-2");
});

it("moves the draft the user typed into during a checkout onto the checkout", async () => {
  setup();
  const prepared = deferred<{
    _tag: "Success";
    value: {
      branch: string;
      worktreePath: string;
      isOnPullRequestHead: boolean;
      pullRequest: { url: string };
    };
  }>();
  // Like the real handler: a draft with user content is not reused, so a later call opens another.
  state.newThread.mockImplementation(
    async (projectRef, options?: { branch?: string; worktreePath?: string }) => {
      const store = useComposerDraftStore.getState();
      const draftId = DraftId.make(options === undefined ? "draft-opened" : "draft-pointed");
      store.setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
        threadId: ThreadId.make(`thread-${draftId}`),
        branch: options?.branch ?? null,
        worktreePath: options?.worktreePath ?? null,
      });
      return { draftId, threadId: ThreadId.make(`thread-${draftId}`) };
    },
  );
  state.prepareThread.mockReturnValueOnce(prepared.promise);
  await using screen = await render(
    <ToastProvider>
      <CheckOutButton />
    </ToastProvider>,
  );

  await userEvent.click(screen.getByRole("button", { name: "Check out" }));
  await expect.poll(() => state.prepareThread.mock.calls.length).toBe(1);
  const opened = DraftId.make("draft-opened");
  useComposerDraftStore.getState().setPrompt(opened, "Review this pull request");
  // A send from this draft waits for the checkout.
  expect(readPendingWorkspaceDefault(opened)).not.toBeNull();
  await act(async () => {
    prepared.resolve({
      _tag: "Success",
      value: {
        branch: "pr-1",
        worktreePath: "/repo-worktrees/pr-1",
        isOnPullRequestHead: true,
        pullRequest: { url: "https://github.com/owner/repo/pull/1" },
      },
    });
    await prepared.promise;
  });
  await expect.element(screen.getByRole("dialog", { name: "Checked out" })).toBeVisible();

  expect(useComposerDraftStore.getState().getComposerDraft(opened)?.prompt).toBe(
    "Review this pull request",
  );
  expect(useComposerDraftStore.getState().getDraftSession(opened)).toMatchObject({
    branch: "pr-1",
    worktreePath: "/repo-worktrees/pr-1",
  });
  expect(readPendingWorkspaceDefault(opened)).toBeNull();
});
