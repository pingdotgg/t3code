import type { ScopedThreadRef } from "@t3tools/contracts";
import { composerTargetKey, type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import {
  handoffPrompt,
  handoffReviewComments,
  stripPullRequestHandoffReferences,
} from "./pullRequestDetail.logic";

/** A pull-request task on its way into a composer, for the reader to read over and send. */
export type PullRequestThreadTask = {
  prompt: string;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
};

/**
 * What the last hand-off wrote into each draft, kept outside React because the panel that wrote it
 * is closed by the time the next one opens. It is how a prompt the reader has since edited is told
 * apart from the one they were handed: only the sentence still exactly as written may be replaced.
 * The native panel and extension hand-offs share it, since they write into the same drafts.
 */
const lastHandoffPromptByDraft = new Map<string, string>();

/**
 * Writes a hand-off's task into a composer draft. It only prepares the draft: nothing is sent.
 *
 * The latest hand-off takes over what an earlier one left, prompt and chips both, rather than
 * stacking under it. What the reader typed themselves survives, with the task under it.
 */
export function writePullRequestTaskToComposer(
  target: ScopedThreadRef | DraftId,
  task: PullRequestThreadTask,
): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const key = composerTargetKey(target);
  const previousCommentIds = new Set((draft?.reviewComments ?? []).map((comment) => comment.id));
  const repeatedCommentIds = new Set(
    (task.reviewComments ?? [])
      .filter((comment) => previousCommentIds.has(comment.id))
      .map((comment) => comment.id),
  );
  const promptWithoutPreviousHandoff = stripPullRequestHandoffReferences(
    draft?.prompt ?? "",
    draft?.reviewComments ?? [],
    repeatedCommentIds,
  );
  const prompt = handoffPrompt(
    {
      prompt: promptWithoutPreviousHandoff,
      lastHandoffPrompt: lastHandoffPromptByDraft.get(key),
    },
    task.prompt,
  );
  lastHandoffPromptByDraft.set(key, task.prompt);
  store.setPrompt(target, prompt);
  store.setReviewComments(
    target,
    handoffReviewComments(draft?.reviewComments ?? [], task.reviewComments ?? []),
  );
  for (const comment of task.reviewComments ?? []) {
    if (!repeatedCommentIds.has(comment.id)) continue;
    store.addReviewComment(target, comment, {
      allowDuplicateReference: true,
      insertAtCaret: false,
    });
  }
}
