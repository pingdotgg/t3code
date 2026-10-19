import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../composerDraftStore";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { canLinkChangeRequest, startTurnWithCheckoutLink } from "./usePullRequestLinking";
import { parseChangeRequestUrl } from "~/lib/openPullRequestLink";

describe("canLinkChangeRequest (#9435 / #9440)", () => {
  const nonGitProject = { id: "scratch-project" } as never;
  const link = parseChangeRequestUrl("https://github.com/pingdotgg/t3code/pull/15111")!;

  it("links a pasted pull request URL when the server tracks links on the thread, even with no matching project", () => {
    expect(canLinkChangeRequest("multiple", [nonGitProject], link)).toBe(true);
    expect(canLinkChangeRequest("multiple", [], link)).toBe(true);
  });

  it("still requires a matching project in single-link mode, where the link needs a projectId", () => {
    expect(canLinkChangeRequest("single", [nonGitProject], link)).toBe(false);
    expect(canLinkChangeRequest("single", [], link)).toBe(false);
  });

  it("never links when the environment does not support pull request linking", () => {
    expect(canLinkChangeRequest("unsupported", [nonGitProject], link)).toBe(false);
  });
});

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("checkout first send", () => {
  const environmentId = EnvironmentId.make("checkout-environment");
  const projectRef = scopeProjectRef(environmentId, ProjectId.make("checkout-project"));
  const initialId = DraftId.make("initial-draft");
  const receiverId = DraftId.make("receiving-draft");
  const initialRef = scopeThreadRef(environmentId, ThreadId.make("initial-thread"));
  const receiverRef = scopeThreadRef(environmentId, ThreadId.make("receiving-thread"));
  const checkout = { url: "https://github.com/acme/widgets/pull/42", branch: "feature/pr-42" };
  const store = () => useComposerDraftStore.getState();
  const success = AsyncResult.success(undefined);
  const failure = AsyncResult.failure(Cause.fail(new Error("Start failed")));

  afterEach(() => {
    useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
    vi.restoreAllMocks();
  });

  it("links only the receiving draft after a failed first send is retried successfully", async () => {
    const link = vi.fn(async () => {});
    store().setProjectDraftThreadId(projectRef, initialId, {
      threadId: initialRef.threadId,
      branch: "main",
    });
    const initialStart = deferred<typeof success>();
    const earlierSend = startTurnWithCheckoutLink({
      threadRef: initialRef,
      draftId: initialId,
      draft: store().getDraftSession(initialId),
      start: () => initialStart.promise,
      link,
    });
    // A checkout finishing during start must have a separate receiving composer.
    expect(
      store().getDraftSessionByLogicalProjectKey(
        store().getDraftSession(initialId)!.logicalProjectKey,
      ),
    ).toBeNull();
    store().setProjectDraftThreadId(projectRef, receiverId, {
      threadId: receiverRef.threadId,
      branch: checkout.branch,
      checkoutPullRequest: checkout,
    });
    initialStart.resolve(success);
    expect(await earlierSend).toBe(success);
    expect(link).not.toHaveBeenCalled();

    const firstStart = deferred<typeof failure>();
    const firstSend = startTurnWithCheckoutLink({
      threadRef: receiverRef,
      draftId: receiverId,
      draft: store().getDraftSession(receiverId),
      start: () => firstStart.promise,
      link,
    });
    expect(link).not.toHaveBeenCalled();
    firstStart.resolve(failure);
    expect(await firstSend).toBe(failure);
    expect(store().getDraftSession(receiverId)).toMatchObject({
      checkoutPullRequest: checkout,
      promotedTo: null,
    });

    const retryStart = deferred<typeof success>();
    const retry = startTurnWithCheckoutLink({
      threadRef: receiverRef,
      draftId: receiverId,
      draft: store().getDraftSession(receiverId),
      start: () => retryStart.promise,
      link,
    });
    // Workspace edits cannot change the already-dispatched thread's workspace.
    store().setDraftThreadContext(receiverId, { worktreePath: "/another/worktree" });
    // Projection-driven navigation can remove the draft before the command response.
    finalizePromotedDraftThreadByRef(receiverRef);
    expect(store().getDraftSession(receiverId)).toBeNull();
    expect(link).not.toHaveBeenCalled();
    retryStart.resolve(success);
    expect(await retry).toBe(success);
    expect(link).toHaveBeenCalledExactlyOnceWith(receiverRef, checkout.url, true);
  });

  it("keeps a successful turn successful when linking fails", async () => {
    store().setProjectDraftThreadId(projectRef, receiverId, {
      threadId: receiverRef.threadId,
      branch: checkout.branch,
      checkoutPullRequest: checkout,
    });
    const logged = deferred<void>();
    vi.spyOn(console, "warn").mockImplementation(() => logged.resolve(undefined));
    const result = await startTurnWithCheckoutLink({
      threadRef: receiverRef,
      draftId: receiverId,
      draft: store().getDraftSession(receiverId),
      start: async () => success,
      link: async () => {
        throw new Error("Link unavailable");
      },
    });
    expect(result).toBe(success);
    await logged.promise;
    expect(store().getDraftSession(receiverId)?.promotedTo).toEqual(receiverRef);
  });

  it("cancels checkout ownership before dispatch and restores the latest workspace after failure", async () => {
    const link = vi.fn(async () => {});
    const prepare = () =>
      store().setProjectDraftThreadId(projectRef, receiverId, {
        threadId: receiverRef.threadId,
        branch: checkout.branch,
        worktreePath: null,
        checkoutPullRequest: checkout,
      });
    const send = (start: () => Promise<typeof success | typeof failure>) =>
      startTurnWithCheckoutLink({
        threadRef: receiverRef,
        draftId: receiverId,
        draft: store().getDraftSession(receiverId),
        start,
        link,
      });
    for (const change of [
      { branch: "another-branch" },
      { worktreePath: "/another/worktree" },
      { projectRef: scopeProjectRef(environmentId, ProjectId.make("another-project")) },
    ]) {
      prepare();
      store().setDraftThreadContext(receiverId, change);
      expect(await send(async () => success)).toBe(success);
      finalizePromotedDraftThreadByRef(receiverRef);
    }
    expect(link).not.toHaveBeenCalled();

    prepare();
    const started = deferred<typeof failure>();
    const pending = send(() => started.promise);
    store().setDraftThreadContext(receiverId, { worktreePath: "/retry/worktree" });
    started.resolve(failure);
    expect(await pending).toBe(failure);
    expect(store().getDraftSession(receiverId)).toMatchObject({
      worktreePath: "/retry/worktree",
      promotedTo: null,
    });
    expect(store().getDraftSession(receiverId)?.checkoutPullRequest).toBeUndefined();
    expect(await send(async () => success)).toBe(success);
    expect(link).not.toHaveBeenCalled();
  });
});
