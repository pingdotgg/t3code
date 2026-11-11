import { AsyncResult } from "effect/reactivity";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { expect, it, vi } from "vite-plus/test";

import type { PullRequestCheckoutPrepared } from "./usePullRequestActions";
import { usePullRequestCheckoutState } from "./pullRequestCheckoutState";

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

const preparedCheckout: PullRequestCheckoutPrepared = {
  pullRequest: { url: "https://github.com/pingdotgg/t3code/pull/1" },
  branch: "pr-1",
  worktreePath: "/tmp/pr-1",
  isOnPullRequestHead: true,
};

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
  expect(usePullRequestCheckoutState.getState().draftIds.has(opened.draftId)).toBe(true);
  expect(state.add.mock.calls[0]?.[0]).toMatchObject({
    type: "loading",
    actionProps: { children: "Cancel" },
  });

  prepare.resolve(AsyncResult.success(preparedCheckout));
  await pending;
  expect(usePullRequestCheckoutState.getState().draftIds.has(opened.draftId)).toBe(false);
  expect(pointThread).toHaveBeenCalledWith(preparedCheckout, opened);
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

it.each(["worktree", "local"] as const)(
  "cancels %s preparation without pointing the thread",
  async (mode) => {
    reset();
    const prepare = deferred<PreparedResult>();
    const clearHandoff = vi.fn();
    const pointThread = vi.fn(async () => true);
    const pending = runPullRequestCheckoutHandoff({
      terminology,
      mode,
      task: { prompt: "Fix the failing check" },
      clearHandoff,
      openThread: async () => opened,
      prepare: () => prepare.promise,
      pointThread,
    });

    await vi.waitFor(() => expect(state.setPrompt).toHaveBeenCalled());
    expect(usePullRequestCheckoutState.getState().draftIds.has(opened.draftId)).toBe(true);
    cancelFromToast();
    expect(clearHandoff).toHaveBeenCalledTimes(mode === "local" ? 0 : 1);
    expect(usePullRequestCheckoutState.getState().draftIds.has(opened.draftId)).toBe(
      mode === "local",
    );
    expect(state.update).toHaveBeenCalledWith(
      state.toastId,
      expect.objectContaining({
        type: mode === "local" ? "loading" : "info",
        title:
          mode === "local" ? "Waiting for the local checkout" : "Stopped applying the checkout",
        timeout: mode === "local" ? 0 : 8_000,
        actionProps: undefined,
      }),
    );

    const nextPrepare = deferred<PreparedResult>();
    const prepareNext = vi.fn(() => nextPrepare.promise);
    const nextPending =
      mode === "worktree"
        ? runPullRequestCheckoutHandoff({
            terminology,
            mode,
            task: null,
            clearHandoff: vi.fn(),
            openThread: async () => opened,
            prepare: prepareNext,
            pointThread,
          })
        : null;
    if (nextPending !== null) await vi.waitFor(() => expect(prepareNext).toHaveBeenCalled());

    prepare.resolve(AsyncResult.success(preparedCheckout));
    await pending;
    expect(pointThread).not.toHaveBeenCalled();
    expect(clearHandoff).toHaveBeenCalled();
    expect(usePullRequestCheckoutState.getState().draftIds.has(opened.draftId)).toBe(
      mode === "worktree",
    );
    if (mode === "local") {
      expect(state.update).toHaveBeenLastCalledWith(
        state.toastId,
        expect.objectContaining({
          title: "Local checkout finished",
          description: "This repository is now on `pr-1`. The thread is still open.",
          timeout: 8_000,
        }),
      );
    }
    nextPrepare.resolve(AsyncResult.success(preparedCheckout));
    await nextPending;
    expect(usePullRequestCheckoutState.getState().draftIds.has(opened.draftId)).toBe(false);
  },
);

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
    prepare: async () => AsyncResult.success(preparedCheckout),
    pointThread,
  });

  cancelFromToast();
  expect(state.setPrompt).not.toHaveBeenCalled();
  open.resolve(opened);
  await pending;
  expect(state.setPrompt).toHaveBeenCalledWith("draft-1", "Fix the failing check");
  expect(pointThread).not.toHaveBeenCalled();
});

it("reports a failed rebind when the opened draft was discarded during prepare", async () => {
  reset();
  const clearHandoff = vi.fn();
  await runPullRequestCheckoutHandoff({
    terminology,
    mode: "worktree",
    task: { prompt: "Fix the failing check" },
    clearHandoff,
    openThread: async () => opened,
    prepare: async () => AsyncResult.success(preparedCheckout),
    pointThread: async () => false,
  });

  expect(clearHandoff).toHaveBeenCalled();
  expect(state.update).toHaveBeenCalledWith(
    state.toastId,
    expect.objectContaining({
      type: "error",
      title: "Checked out, but the thread stayed where it was",
    }),
  );
});
