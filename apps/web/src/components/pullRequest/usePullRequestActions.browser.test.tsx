import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PullRequestAction,
  type PullRequestRef,
} from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { useComposerDraftStore } from "~/composerDraftStore";
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

function MergeButton({
  reference,
  action = "merge",
}: {
  reference: PullRequestRef;
  action?: PullRequestAction;
}) {
  const { actionPending, pendingAction, perform } = usePullRequestActionRunner({
    environmentId: EnvironmentId.make("environment"),
    reference,
    terminology: sourceControlClients.get(undefined).changeRequest,
  });
  return (
    <button type="button" disabled={actionPending} onClick={() => void perform(action)}>
      {pendingAction === "ready" ? "Marking..." : actionPending ? "Merging..." : "Merge"}
    </button>
  );
}

function setup() {
  state.runAction.mockReset();
  state.newThread.mockReset();
  state.prepareThread.mockReset();
}

it.each([
  { action: "merge", scope: "number" },
  { action: "ready", scope: "number" },
  { action: "merge", scope: "project" },
  { action: "ready", scope: "project" },
] as const)(
  "keeps a pending $action action with its pull request when changing $scope",
  async ({ action, scope }) => {
    setup();
    const pendingLabel = action === "ready" ? "Marking..." : "Merging...";
    const first: PullRequestRef = {
      projectId: ProjectId.make("project"),
      repository: "owner/repo",
      number: 1,
    };
    const second =
      scope === "number"
        ? { ...first, number: 2 }
        : { ...first, projectId: ProjectId.make("other-project") };
    const firstResult = deferred<{ _tag: "Success"; value: void }>();
    const secondResult = deferred<{ _tag: "Success"; value: void }>();
    state.runAction
      .mockReturnValueOnce(firstResult.promise)
      .mockReturnValueOnce(secondResult.promise);
    await using screen = await render(<MergeButton reference={first} action={action} />);
    const button = screen.getByRole("button");

    await userEvent.click(button);
    await expect.element(button).toHaveTextContent(pendingLabel);
    await screen.rerender(<MergeButton reference={second} />);
    await expect.element(button).toHaveTextContent("Merge");
    await expect.element(button).toBeEnabled();
    await userEvent.click(button);
    expect(state.runAction).toHaveBeenCalledTimes(2);

    await screen.rerender(<MergeButton reference={first} />);
    await expect.element(button).toHaveTextContent(pendingLabel);
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
  },
);

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
