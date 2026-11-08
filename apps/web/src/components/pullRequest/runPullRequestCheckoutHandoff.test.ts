import { AsyncResult } from "effect/reactivity";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { expect, it, vi } from "vite-plus/test";

import type { PullRequestCheckoutPrepared } from "./usePullRequestActions";

const state = vi.hoisted(() => ({
  toastId: "checkout-toast",
  add: vi.fn<(options: unknown) => string>(() => "checkout-toast"),
  update: vi.fn(),
  setPrompt: vi.fn(),
  setReviewComments: vi.fn(),
  getComposerDraft: vi.fn(() => ({ prompt: "", reviewComments: [] })),
}));

vi.mock("../ui/toast", () => ({
  toastManager: {
    add: state.add,
    update: state.update,
  },
}));

vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: state.getComposerDraft,
      setPrompt: state.setPrompt,
      setReviewComments: state.setReviewComments,
    }),
  },
}));

import { runPullRequestCheckoutHandoff } from "./usePullRequestActions";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const terminology = sourceControlClients.get(undefined).changeRequest;

type PreparedResult = AtomCommandResult<PullRequestCheckoutPrepared, unknown>;

const opened = { draftId: "draft-1" as never, threadId: "thread-1" as never };

function reset() {
  state.add.mockClear().mockReturnValue(state.toastId);
  state.update.mockClear();
  state.setPrompt.mockClear();
  state.setReviewComments.mockClear();
  state.getComposerDraft.mockReturnValue({ prompt: "", reviewComments: [] });
}

function cancelFromToast() {
  const toast = state.add.mock.calls[0]?.[0] as
    | { actionProps?: { onClick?: () => void } }
    | undefined;
  toast?.actionProps?.onClick?.();
}

it("puts the task in the composer before checkout finishes", async () => {
  reset();
  const prepare = deferred<PreparedResult>();
  const clearHandoff = vi.fn();
  const pointThread = vi.fn(async () => true);
  const pending = runPullRequestCheckoutHandoff({
    terminology,
    mode: "worktree",
    task: { prompt: "Fix the failing check" },
    clearHandoff,
    openThread: async () => opened,
    prepare: () => prepare.promise,
    pointThread,
  });

  await vi.waitFor(() => expect(state.setPrompt).toHaveBeenCalled());
  expect(state.setPrompt).toHaveBeenCalledWith("draft-1", "Fix the failing check");
  expect(pointThread).not.toHaveBeenCalled();
  expect(state.add.mock.calls[0]?.[0]).toMatchObject({
    type: "loading",
    actionProps: { children: "Cancel" },
  });

  prepare.resolve(
    AsyncResult.success({
      branch: "pr-1",
      worktreePath: "/tmp/pr-1",
      isOnPullRequestHead: true,
    }),
  );
  await pending;
  expect(pointThread).toHaveBeenCalledWith(
    {
      branch: "pr-1",
      worktreePath: "/tmp/pr-1",
      isOnPullRequestHead: true,
    },
    opened,
  );
  expect(clearHandoff).toHaveBeenCalled();
  expect(state.update).toHaveBeenCalledWith(
    state.toastId,
    expect.objectContaining({
      type: "success",
      title: "Checkout ready",
      timeout: 8_000,
      actionProps: undefined,
    }),
  );
});

it("cancels preparation and keeps the prompt without pointing the thread", async () => {
  reset();
  const prepare = deferred<PreparedResult>();
  const clearHandoff = vi.fn();
  const pointThread = vi.fn(async () => true);
  const pending = runPullRequestCheckoutHandoff({
    terminology,
    mode: "worktree",
    task: { prompt: "Fix the failing check" },
    clearHandoff,
    openThread: async () => opened,
    prepare: () => prepare.promise,
    pointThread,
  });

  await vi.waitFor(() => expect(state.setPrompt).toHaveBeenCalled());
  cancelFromToast();
  expect(clearHandoff).toHaveBeenCalled();
  expect(state.update).toHaveBeenCalledWith(
    state.toastId,
    expect.objectContaining({
      type: "info",
      title: "Stopped applying the checkout",
      timeout: 8_000,
      actionProps: undefined,
    }),
  );

  prepare.resolve(
    AsyncResult.success({
      branch: "pr-1",
      worktreePath: "/tmp/pr-1",
      isOnPullRequestHead: true,
    }),
  );
  await pending;
  expect(pointThread).not.toHaveBeenCalled();
});

it("seeds the prompt when cancel lands while openThread is still pending", async () => {
  reset();
  const open = deferred<typeof opened>();
  const clearHandoff = vi.fn();
  const pointThread = vi.fn(async () => true);
  const pending = runPullRequestCheckoutHandoff({
    terminology,
    mode: "worktree",
    task: { prompt: "Fix the failing check" },
    clearHandoff,
    openThread: () => open.promise,
    prepare: async () =>
      AsyncResult.success({
        branch: "pr-1",
        worktreePath: "/tmp/pr-1",
        isOnPullRequestHead: true,
      }),
    pointThread,
  });

  cancelFromToast();
  expect(state.setPrompt).not.toHaveBeenCalled();
  open.resolve(opened);
  await pending;
  expect(state.setPrompt).toHaveBeenCalledWith("draft-1", "Fix the failing check");
  expect(pointThread).not.toHaveBeenCalled();
});
