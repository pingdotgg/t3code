import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type PullRequestAction,
  type PullRequestMergeMethod,
  type PullRequestUpdateMethod,
  type PullRequestReviewGuideStop,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { offHeadPullRequestCheckoutToast } from "./pullRequestCheckoutToast";

import type { ReviewCommentContext } from "~/reviewCommentContext";

import { readEnvironmentScope } from "~/state/session";

import { toastManager } from "../ui/toast";

import {
  buildAskAboutGuideStopHandoff,
  buildAskAboutPullRequestHandoff,
  buildExplainPullRequestHandoff,
  handoffPrompt,
  handoffReviewComments,
  pullRequestActionNeedsHostRefresh,
  pullRequestHandoffLabels,
  checkoutFailureDescription,
  readableFailure,
  stripPullRequestHandoffReferences,
} from "./pullRequestDetail.logic";

import { useReviewGuideWriter } from "./guide/useReviewGuideWriter";

import {
  UPDATE_BRANCH_REBASE_FAILURE_HINT,
  actionFailureHints,
  actionFailureLabels,
  composerTargetKey,
  lastHandoffPromptByDraft,
} from "./pullRequestDetailPanelShared";

import type { PullRequestDetailPanelData } from "./usePullRequestDetailPanelData";

/**
 * The detail panel's actions: merge, comment, checkout and the handoffs into a thread. Each one
 * lands through the same action command and refreshes what it changed.
 */
export function usePullRequestDetailPanelActions(prev: PullRequestDetailPanelData) {
  const {
    acting,
    actingEnvironmentId,
    canOperateThread,
    canWriteSourceControl,
    checkoutRoot,
    composerDraftTarget,
    detail,
    environmentId,
    handoff,
    handoffSummary,
    newThread,
    onActed,
    pendingAction,
    postComment,
    prepareThread,
    reference,
    refreshDetail,
    refreshFromHost,
    runAction,
    selectTab,
    setHandoff,
    setPendingAction,
    terminology,
  } = prev;
  const finishAction = async (
    action: PullRequestAction,
    method?: PullRequestMergeMethod,
    updateMethod?: PullRequestUpdateMethod,
  ) => {
    onActed?.(action, "sent");
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        action,
        ...(method ? { mergeMethod: method } : {}),
        ...(updateMethod ? { updateMethod } : {}),
      },
    });
    setPendingAction(null);
    if (result._tag === "Failure") {
      // Azure DevOps provides no strategy availability; explain policy failures after the attempt.
      const failure = squashAtomCommandFailure(result);
      const hint =
        updateMethod === "rebase"
          ? UPDATE_BRANCH_REBASE_FAILURE_HINT
          : actionFailureHints(terminology.singular)[action];
      toastManager.add({
        type: "error",
        title: actionFailureLabels(terminology.singular)[action],
        description: readableFailure(failure, hint),
      });
      onActed?.(action, "failed");
      return false;
    }
    if (action === "revert") {
      toastManager.add({ type: "success", title: `Revert ${terminology.singular} opened` });
    }
    if (action === "delete-branch") {
      toastManager.add({ type: "success", title: "Branch deleted" });
    }
    if (pullRequestActionNeedsHostRefresh(action)) {
      void refreshFromHost();
    } else {
      refreshDetail();
    }
    onActed?.(action, "done");
    return true;
  };

  const perform = async (
    action: PullRequestAction,
    method?: PullRequestMergeMethod,
    updateMethod?: PullRequestUpdateMethod,
  ) => {
    if (!canWriteSourceControl || pendingAction !== null) return false;
    setPendingAction(action);
    return finishAction(action, method, updateMethod);
  };

  const performCommentAction = async (body: string, action: "close" | "reopen") => {
    if (!canWriteSourceControl || pendingAction !== null) return { commentPosted: false };
    setPendingAction(action);
    const commentResult = await postComment({
      environmentId,
      input: { ...reference, body },
    });
    if (commentResult._tag === "Failure") {
      setPendingAction(null);
      toastManager.add({ type: "error", title: "Could not post the comment" });
      return { commentPosted: false };
    }
    const actionSucceeded = await finishAction(action);
    // Refresh the posted comment even if the subsequent state change fails.
    if (!actionSucceeded) refreshDetail();
    return { commentPosted: true };
  };

  type ThreadTask = {
    prompt: string;
    reviewComments?: ReadonlyArray<ReviewCommentContext>;
  };

  const attachTarget = composerDraftTarget ?? null;
  const canPrepareWorktree = prepareThread.isAllowed && canOperateThread;
  const canFixFindings = attachTarget !== null || canPrepareWorktree;
  const handoffLabels = pullRequestHandoffLabels(attachTarget !== null);
  const guideWriter = useReviewGuideWriter({
    environmentId,
    reference,
    title: detail?.title ?? null,
  });
  const writeGuide = () => {
    void guideWriter.write();
    if (guideWriter.data?.guide == null) selectTab("guide");
  };

  const writeTaskToComposer = (target: ScopedThreadRef | DraftId, task: ThreadTask) => {
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
  };

  const openThreadWithTask = async (
    projectRef: ReturnType<typeof scopeProjectRef>,
    task: ThreadTask | null,
    opened?: { draftId: DraftId },
  ): Promise<{ draftId: DraftId } | null> => {
    const session =
      opened ??
      (await newThread(projectRef).then(
        (result) => result,
        () => null,
      ));
    if (session === null) return null;
    if (task === null) return session;
    writeTaskToComposer(session.draftId, task);
    return session;
  };

  const startAsk = async (
    kind: string,
    task: ThreadTask,
    options?: { readonly keepGuide?: boolean },
  ) => {
    if (!detail || handoff !== null) return;
    if (attachTarget !== null) {
      writeTaskToComposer(attachTarget, task);
      toastManager.add({
        type: "success",
        title: "Added to the composer",
        description:
          task.prompt.length > 0
            ? "The question is in the composer. Read it over, then send."
            : `The ${terminology.singular} is in the composer. Type your question, then send.`,
      });
      return;
    }
    setHandoff(kind);
    const projectRef = scopeProjectRef(actingEnvironmentId, acting?.projectId ?? detail.projectId);
    const opened = await openThreadWithTask(projectRef, task);
    setHandoff(null);
    if (opened !== null && options?.keepGuide === true) {
      const draft = useComposerDraftStore.getState().getDraftSession(opened.draftId);
      if (draft !== null) {
        useRightPanelStore
          .getState()
          .openPullRequest(scopeThreadRef(draft.environmentId, draft.threadId), {
            environmentId,
            projectId: reference.projectId,
            ...(reference.host === undefined ? {} : { host: reference.host }),
            repository: reference.repository,
            number: reference.number,
            url: detail.url,
            detailTab: "guide",
          });
      }
    }
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: "Could not open a thread",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: "Asked in a thread",
      description:
        task.prompt.length > 0
          ? "The question is in the composer. Read it over, then send."
          : `The ${terminology.singular} is in the composer. Type your question, then send.`,
    });
  };

  const startHandoff = async (
    kind: string,
    task: { prompt: string; reviewComments?: ReadonlyArray<ReviewCommentContext> } | null,
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!handoffSummary || handoff !== null) return;
    if (attachTarget !== null && task !== null) {
      writeTaskToComposer(attachTarget, task);
      toastManager.add({
        type: "success",
        title: "Added to the composer",
        description: "The task is in the composer. Read it over, then send.",
      });
      return;
    }
    if (checkoutRoot === null) return;
    if (
      !prepareThread.isAllowed ||
      !readEnvironmentScope(actingEnvironmentId, AuthSourceControlWriteScope)
    ) {
      return;
    }
    if (
      mode === "worktree" &&
      !readEnvironmentScope(actingEnvironmentId, AuthOrchestrationOperateScope)
    ) {
      return;
    }
    setHandoff(kind);
    const toastId = toastManager.add({
      type: "loading",
      title: `Preparing the ${terminology.singular} checkout...`,
    });
    const projectRef = scopeProjectRef(
      actingEnvironmentId,
      acting?.projectId ?? handoffSummary.projectId,
    );
    // Checkout setup requires the thread to exist first.
    const opened = await newThread(projectRef).then(
      (session) => session,
      () => null,
    );
    if (opened === null) {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: "Could not open a thread for the checkout",
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    const prepared = await prepareThread.run({
      reference: handoffSummary.url,
      mode,
      threadId: opened.threadId,
    });
    if (prepared._tag === "Failure") {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: `Could not prepare the ${terminology.singular} checkout`,
        description: checkoutFailureDescription(
          isAtomCommandInterrupted(prepared) ? undefined : squashAtomCommandFailure(prepared),
        ),
      });
      return;
    }
    const pointed = await newThread(projectRef, {
      branch: prepared.value.branch,
      worktreePath: prepared.value.worktreePath,
      envMode: prepared.value.worktreePath === null ? "local" : "worktree",
    }).then(
      (session) => session !== null,
      () => false,
    );
    if (!pointed) {
      setHandoff(null);
      // Sending after failed rebinding would use the previous checkout.
      toastManager.update(toastId, {
        type: "error",
        title: "Checked out, but the thread stayed where it was",
        description: `The checkout is ready on \`${prepared.value.branch}\`. Point a thread at it from the branch picker, then ask again.`,
      });
      return;
    }
    setHandoff(null);
    if (task === null) {
      toastManager.update(
        toastId,
        prepared.value.isOnPullRequestHead
          ? {
              type: "success",
              title: mode === "local" ? "Checked out here" : "Checked out",
              description:
                mode === "local"
                  ? `This repository is on the ${terminology.singular}'s branch, with a thread open on it.`
                  : `The ${terminology.singular} is in its own worktree, with a thread open on it.`,
            }
          : offHeadPullRequestCheckoutToast(terminology),
      );
      return;
    }
    await openThreadWithTask(projectRef, task, opened);
    toastManager.update(
      toastId,
      prepared.value.isOnPullRequestHead
        ? {
            type: "success",
            title: "Checkout ready",
            description: "The task is in the composer. Read it over, then send.",
          }
        : offHeadPullRequestCheckoutToast(terminology),
    );
  };

  const askAboutPullRequest = () => {
    if (!detail) return;
    void startAsk("ask", {
      ...buildAskAboutPullRequestHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        state: detail.state,
        isDraft: detail.isDraft,
      }),
    });
  };

  const explainPullRequest = () => {
    if (!detail) return;
    void startAsk("explain", {
      ...buildExplainPullRequestHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        state: detail.state,
        isDraft: detail.isDraft,
      }),
    });
  };

  const askAboutGuideStop = (stop: PullRequestReviewGuideStop, index: number, question: string) => {
    if (!detail) return;
    void startAsk(
      `guide-stop:${index}`,
      buildAskAboutGuideStopHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        state: detail.state,
        isDraft: detail.isDraft,
        stop: {
          index,
          title: stop.title,
          summary: stop.summary,
          attention: stop.attention?.note ?? null,
          excerpts: stop.excerpts,
        },
        question,
      }),
      { keepGuide: true },
    );
  };

  return {
    ...prev,
    askAboutGuideStop,
    askAboutPullRequest,
    attachTarget,
    canFixFindings,
    canPrepareWorktree,
    explainPullRequest,
    guideWriter,
    handoffLabels,
    perform,
    performCommentAction,
    startAsk,
    startHandoff,
    writeGuide,
  };
}

export type PullRequestDetailPanelActions = ReturnType<typeof usePullRequestDetailPanelActions>;
