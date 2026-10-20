import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PullRequestRef } from "@t3tools/contracts";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastManager } from "../ui/toast";
import {
  pullRequestReviewKey,
  savePendingReviewComment,
  usePullRequestReviewStore,
  type PendingReviewComment,
} from "./pullRequestReviewStore";

/** Saving a review comment stays private until the review is submitted. */
export function usePendingReviewCommentActions(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
) {
  const key = pullRequestReviewKey(reference);
  const canSave = useAtomValue(
    pullRequestEnvironment.saveDraftComment.permissionAtom(environmentId),
  );
  const canDiscard = useAtomValue(
    pullRequestEnvironment.discardDraftComment.permissionAtom(environmentId),
  );
  const busy = usePullRequestReviewStore((store) => (store.busyComments[key]?.length ?? 0) > 0);
  const save = useAtomCommand(pullRequestEnvironment.saveDraftComment, { reportFailure: false });
  const remove = useAtomCommand(pullRequestEnvironment.discardDraftComment, {
    reportFailure: false,
  });
  const saveDraft = async (comment: PendingReviewComment) => {
    return await (async () => {
      return await savePendingReviewComment(key, comment, async (draft) => {
        const result = await save({ environmentId, input: { ...reference, comment: draft } });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        return result.value;
      });
    })().catch(async (cause: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not save the pending comment to GitHub",
        description:
          cause instanceof Error ? cause.message : "Your draft is kept in T3. Retry saving it.",
      });
      return null;
    });
  };
  const add = (comment: PendingReviewComment, saveToHost: boolean) => {
    usePullRequestReviewStore.getState().addComment(key, comment);
    if (saveToHost) void saveDraft(comment);
  };
  const copyLink = async (comment: PendingReviewComment) => (await saveDraft(comment))?.url ?? null;
  const discard = async (givenComment: PendingReviewComment) => {
    const store = usePullRequestReviewStore.getState();
    const comment =
      store.drafts[key]?.find((entry) => entry.id === givenComment.id) ?? givenComment;
    if (store.busyComments[key]?.includes(comment.id)) return false;
    store.setCommentBusy(key, comment.id, true);
    return await (async () => {
      if (comment.hostedComment) {
        const result = await remove({
          environmentId,
          input: { ...reference, ...comment.hostedComment },
        });
        if (result._tag === "Failure") {
          toastManager.add({ type: "error", title: "Could not discard the pending comment" });
          return false;
        }
      }
      store.removeComments(
        key,
        [comment.id],
        comment.hostedComment ? [comment.hostedComment.commentId] : [],
      );
      return true;
    })().finally(async () => {
      store.setCommentBusy(key, comment.id, false);
    });
  };
  const discardAll = async (comments: ReadonlyArray<PendingReviewComment>) => {
    for (const comment of comments) {
      if (!(await discard(comment))) return;
    }
  };
  return { busy, canSave, canDiscard, add, saveDraft, copyLink, discard, discardAll };
}
