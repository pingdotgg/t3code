import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Alert } from "react-native";
import * as Clipboard from "expo-clipboard";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import type { PendingReviewComment } from "./pullRequestReviewDrafts";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";
import {
  readReviewDraft,
  retireReviewDraftComments,
  setReviewDraftBusy,
  usePullRequestReviewDraftCommands,
} from "./usePullRequestReviewDraft";

/** A copied link saves a private GitHub draft; discard and submit retain that host identity. */
export function usePendingReviewCommentActions(params: PullRequestParams) {
  const target = pullRequestTarget(params);
  const detail = useEnvironmentQuery(
    composerPullRequests.detail({ ...target, input: { ...target.input, allowStale: false } }),
  );
  const viewer = !detail.isPending && !detail.error ? detail.data?.viewer?.trim() || null : null;
  const scope = { ...params, viewer };
  const store = usePullRequestReviewDraftCommands(scope);
  const activity = useEnvironmentQuery(composerPullRequests.activity(target));
  const canSave = useAtomValue(
    composerPullRequests.saveDraftComment.permissionAtom(target.environmentId),
  );
  const canDiscard = useAtomValue(
    composerPullRequests.discardDraftComment.permissionAtom(target.environmentId),
  );
  const save = useAtomCommand(composerPullRequests.saveDraftComment, { reportFailure: false });
  const remove = useAtomCommand(composerPullRequests.discardDraftComment, { reportFailure: false });
  const copyLink = async (given: PendingReviewComment) => {
    if (!store.isReady() || detail.data === null || detail.error) return;
    const comment = readReviewDraft(scope).comments.find((entry) => entry.id === given.id) ?? given;
    if (comment.hostedComment) {
      await Clipboard.setStringAsync(comment.hostedComment.url);
      return;
    }
    if (!canSave || !setReviewDraftBusy(scope, true)) return;
    return await (async () => {
      const result = await save({ ...target, input: { ...target.input, comment } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      store.complete((draft) => ({
        ...draft,
        comments: draft.comments.map((entry) =>
          entry.id === comment.id ? { ...entry, hostedComment: result.value } : entry,
        ),
      }));
      await store.flush();
      await Clipboard.setStringAsync(result.value.url);
      detail.refresh();
      activity.refresh();
    })()
      .catch(async (cause: unknown) => {
        Alert.alert(
          "Could not copy the pending comment link",
          cause instanceof Error ? cause.message : "Your draft has been kept. Try again.",
        );
      })
      .finally(async () => {
        setReviewDraftBusy(scope, false);
      });
  };
  const discard = async (given: PendingReviewComment) => {
    if (!store.isReady() || detail.data === null || detail.error) return false;
    const comment = readReviewDraft(scope).comments.find((entry) => entry.id === given.id) ?? given;
    if (!setReviewDraftBusy(scope, true)) return false;
    return await (async () => {
      if (comment.hostedComment) {
        if (!canDiscard) throw new Error("This connection cannot discard saved review comments.");
        const result = await remove({
          ...target,
          input: { ...target.input, ...comment.hostedComment },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }
      store.complete((draft) => ({
        ...draft,
        comments: draft.comments.filter((entry) => entry.id !== comment.id),
      }));
      if (!(await store.flush())) {
        store.complete((draft) =>
          draft.comments.some((entry) => entry.id === comment.id)
            ? draft
            : { ...draft, comments: [...draft.comments, comment] },
        );
        throw new Error(
          "The comment was removed from the host, but this device could not save the draft. Retry to finish discarding it.",
        );
      }
      retireReviewDraftComments(scope, [comment]);
      detail.refresh();
      activity.refresh();
      return true;
    })()
      .catch(async (cause: unknown) => {
        Alert.alert(
          "Could not discard the pending comment",
          cause instanceof Error ? cause.message : "Your draft has been kept. Try again.",
        );
        return false;
      })
      .finally(async () => {
        setReviewDraftBusy(scope, false);
      });
  };
  return {
    busy: store.busy,
    canSave: store.ready && canSave && detail.data?.capabilities.review.draftComment === true,
    canDiscard: store.ready && canDiscard,
    copyLink,
    discard,
  };
}
