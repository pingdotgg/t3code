import { useAtomCommand } from "~/state/use-atom-command";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestAction,
  PullRequestDetail,
  PullRequestMergeMethod,
  PullRequestRef,
  PullRequestSummary,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import {
  capitalizeTerm,
  sourceControlClients,
  type ChangeRequestTerminology,
} from "@t3tools/client-runtime/source-control-clients";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useClientSettings, useEnvironmentSettings } from "~/hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { buildPhysicalToLogicalProjectKeyMap } from "~/sidebarProjectGrouping";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { usePreparePullRequestThreadAction } from "~/state/sourceControlActions";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { pullRequestEnvironment } from "~/state/pullRequests";

import { toastManager } from "../ui/toast";
import { offHeadPullRequestCheckoutToast } from "./pullRequestCheckoutToast";
import {
  checkoutFailureDescription,
  appendHandoff,
  readableFailure,
} from "./pullRequestDetail.logic";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

import { translateNow } from "../media/translateNow";
export function usePullRequestDefaultMergeMethodResolver(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
) {
  const projectDefault = useEnvironmentSettings(
    environmentId,
    (settings) => resolveProjectSettings(settings, projectId).settings.pullRequestMergeMethod,
  );
  const legacyOverrides = useClientSettings((settings) => settings.pullRequestMergeMethodOverrides);
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return () => {
    if (projectDefault != null) return projectDefault;
    if (Object.keys(legacyOverrides).length === 0) return undefined;
    const project = projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    );
    if (!project) return undefined;
    const key =
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: grouping,
        primaryEnvironmentId,
      }).get(derivePhysicalProjectKey(project)) ??
      deriveLogicalProjectKeyFromSettings(project, grouping);
    return legacyOverrides[key];
  };
}

const actionSuccessLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: translateNow("review.extra.merge.requested"),
  ready: translateNow("review.extra.marked.ready.for.review"),
  draft: translateNow("review.extra.converted.to.draft"),
  close: translateNow("review.pr.termClosed", { term: capitalizeTerm(term) }),
  reopen: translateNow("review.pr.termReopened", { term: capitalizeTerm(term) }),
  "update-branch": translateNow("review.extra.branch.updated.with.the.base.branch"),
  "enable-auto-merge": translateNow("review.extra.auto.merge.enabled"),
  "disable-auto-merge": translateNow("review.extra.auto.merge.disabled"),
  revert: translateNow("review.pr.revertOpened", { term }),
  "delete-branch": translateNow("review.extra.branch.deleted"),
  "approve-workflows": translateNow("review.extra.workflows.approved"),
});

const actionFailureLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: translateNow("review.pr.couldNotMerge", { term }),
  ready: translateNow("review.extra.could.not.mark.this.ready.for.review"),
  draft: translateNow("review.extra.could.not.convert.this.to.a.draft"),
  close: translateNow("review.pr.couldNotClose", { term }),
  reopen: translateNow("review.pr.couldNotReopen", { term }),
  "update-branch": translateNow("review.extra.could.not.update.this.branch"),
  "enable-auto-merge": translateNow("review.extra.could.not.enable.auto.merge"),
  "disable-auto-merge": translateNow("review.extra.could.not.disable.auto.merge"),
  revert: translateNow("review.pr.couldNotRevert", { term }),
  "delete-branch": translateNow("review.extra.could.not.delete.this.branch"),
  "approve-workflows": translateNow("review.extra.could.not.approve.workflows"),
});

const actionFailureHints = (term: string): Record<PullRequestAction, string> => ({
  merge: translateNow("review.extra.the.host.refused.the.merge.check.that.you"),
  ready: translateNow("review.extra.the.host.refused.it.check.that.you.have"),
  draft: translateNow("review.extra.the.host.refused.it.check.that.you.have"),
  close: translateNow("review.extra.the.host.refused.it.check.that.you.have2"),
  reopen: translateNow("review.extra.the.host.refused.it.check.that.you.have3"),
  "update-branch": translateNow("review.extra.the.host.refused.it.check.that.you.have10"),
  "enable-auto-merge": translateNow("review.extra.the.host.refused.it.check.that.auto.merge"),
  "disable-auto-merge": translateNow("review.extra.the.host.refused.it.check.that.you.have"),
  revert: translateNow("review.pr.revertRefused", { term }),
  "delete-branch": translateNow("review.extra.the.host.refused.it.check.that.you.have6"),
  "approve-workflows": translateNow("review.extra.the.host.refused.it.check.that.you.have7"),
});

export function usePullRequestActionRunner({
  environmentId,
  reference,
  terminology,
  onSuccess,
  resolveMergeMethod,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef | null;
  terminology: ChangeRequestTerminology;
  onSuccess?: (action: PullRequestAction, reply: PullRequestSummary | undefined) => void;
  /** Resolve repository settings on click to avoid per-row reads. */
  resolveMergeMethod?: (detail: PullRequestDetail) => PullRequestMergeMethod;
}) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, {
    reportFailure: false,
  });
  const pendingRef = useRef(new Set<string>());
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const actionKey =
    reference === null
      ? null
      : JSON.stringify([
          environmentId,
          reference.host ?? null,
          reference.repository,
          reference.number,
        ]);
  const actionPending = actionKey !== null && pendingKeys.has(actionKey);

  const perform = async (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (actionKey === null || reference === null || pendingRef.current.has(actionKey)) return;
    pendingRef.current.add(actionKey);
    setPendingKeys(new Set(pendingRef.current));
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        action,
        ...(method ? { mergeMethod: method } : resolveMergeMethod ? { resolveMergeMethod } : {}),
      },
    });
    pendingRef.current.delete(actionKey);
    setPendingKeys(new Set(pendingRef.current));
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: actionFailureLabels(terminology.singular)[action],
        description: readableFailure(
          squashAtomCommandFailure(result),
          actionFailureHints(terminology.singular)[action],
        ),
      });
      return;
    }
    toastManager.add({ type: "success", title: actionSuccessLabels(terminology.singular)[action] });
    onSuccess?.(action, result.value);
  };

  return { actionPending, perform };
}

export function usePullRequestCloseBatch(
  onClosed: (entry: EnvironmentPullRequestEntry, reply: PullRequestSummary | undefined) => void,
) {
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, { reportFailure: false });
  const pending = useRef(new Set<string>());
  const [closingKeys, setClosingKeys] = useState<ReadonlySet<string>>(() => new Set());
  const close = async (entries: readonly EnvironmentPullRequestEntry[]) => {
    const batch = entries.filter((entry) => {
      const key = pullRequestEntryKey(entry);
      if (entry.state !== "open" || pending.current.has(key)) return false;
      pending.current.add(key);
      return true;
    });
    if (batch.length === 0) return;
    setClosingKeys(new Set(pending.current));
    const failures: string[] = [];
    const outcomes = await Promise.all(
      batch.map(async (entry) => {
        const result = await runAction({
          environmentId: entry.environmentId,
          input: {
            projectId: entry.projectId,
            host: entry.host,
            repository: entry.repository,
            number: entry.number,
            action: "close",
          },
        });
        pending.current.delete(pullRequestEntryKey(entry));
        setClosingKeys(new Set(pending.current));
        if (result._tag === "Failure") {
          failures.push(
            `#${entry.number}: ${readableFailure(squashAtomCommandFailure(result), actionFailureHints(sourceControlClients.get(entry.provider).changeRequest.singular).close)}`,
          );
          return;
        }
        onClosed(entry, result.value);
        return true;
      }),
    );
    const closed = outcomes.filter(Boolean).length;
    toastManager.add({
      type: failures.length > 0 ? "error" : "success",
      title:
        failures.length > 0
          ? translateNow("review.pr.closedOfN", { closed, total: batch.length })
          : translateNow("review.pr.closedN", { closed, plural: closed === 1 ? "" : "s" }),
      ...(failures.length > 0 ? { description: failures.slice(0, 3).join("\n") } : {}),
    });
  };
  return { close, closingKeys };
}

export interface PullRequestThreadTask {
  prompt: string;
  reviewComments?: ReadonlyArray<ReviewCommentContext>;
}

export function writeHandoffToComposer(
  target: ScopedThreadRef | DraftId,
  task: PullRequestThreadTask,
) {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const next = appendHandoff(
    { prompt: draft?.prompt ?? "", reviewComments: draft?.reviewComments ?? [] },
    task,
  );
  store.setPrompt(target, next.prompt);
  store.setReviewComments(target, next.reviewComments);
}

export type PullRequestHandoffDetail = Pick<
  PullRequestDetail,
  "projectId" | "workspaceRoot" | "url"
>;

export function usePullRequestHandoffs({
  environmentId,
  detail,
}: {
  environmentId: EnvironmentId;
  detail: PullRequestHandoffDetail | null;
}) {
  const newThread = useNewThreadHandler();
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId,
    cwd: detail?.workspaceRoot ?? null,
  });
  // Serialize all handoffs because they check out the same pull request.
  const [handoff, setHandoff] = useState<string | null>(null);
  // Prompt links hand over a URL alone, so the URL is what names the host.
  const terminology = (
    (detail && sourceControlClients.findByChangeRequestUrl(detail.url)) ||
    sourceControlClients.get(undefined)
  ).changeRequest;

  // Questions must not change checkouts or create worktrees.
  const openThreadWithTask = async (
    projectRef: ReturnType<typeof scopeProjectRef>,
    task: PullRequestThreadTask | null,
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
    writeHandoffToComposer(session.draftId, task);
    return session;
  };

  const startAsk = async (kind: string, task: PullRequestThreadTask) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    const opened = await openThreadWithTask(projectRef, task);
    setHandoff(null);
    if (opened === null) {
      toastManager.add({
        type: "error",
        title: translateNow("review.extra.could.not.open.a.thread"),
        description: translateNow("review.extra.try.again.from.the.project.or.open.a"),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: translateNow("review.extra.asked.in.a.thread"),
      description:
        task.prompt.length > 0
          ? translateNow("review.extra.the.question.is.in.the.composer.read.it")
          : translateNow("review.pr.inComposer", { term: terminology.singular }),
    });
  };

  const startHandoff = async (
    kind: string,
    task: PullRequestThreadTask | null,
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    // Explicit timeouts survive toast updates and would pin the result after loading.
    const toastId = toastManager.add({
      type: "loading",
      title: translateNow("review.pr.preparingCheckout", { term: terminology.singular }),
    });
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    // Checkout setup requires the thread to exist first.
    const opened = await newThread(projectRef).then(
      (session) => session,
      () => null,
    );
    if (opened === null) {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: translateNow("review.extra.could.not.open.a.thread.for.the.checkout"),
        description: translateNow("review.extra.try.again.from.the.project.or.open.a"),
      });
      return;
    }
    const prepared = await prepareThread.run({
      reference: detail.url,
      mode,
      threadId: opened.threadId,
    });
    if (prepared._tag === "Failure") {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: translateNow("review.pr.couldNotPrepareCheckout", { term: terminology.singular }),
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
      toastManager.update(toastId, {
        type: "error",
        title: translateNow("review.extra.checked.out.but.the.thread.stayed.where.it"),
        description: translateNow("review.pr.checkoutReady", { branch: prepared.value.branch }),
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
              title:
                mode === "local"
                  ? translateNow("review.extra.checked.out.here")
                  : translateNow("review.extra.checked.out"),
              description:
                mode === "local"
                  ? translateNow("review.pr.repoOnBranch", { term: terminology.singular })
                  : translateNow("review.pr.inOwnWorktree", { term: terminology.singular }),
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
            title: translateNow("review.extra.checkout.ready"),
            description: translateNow("review.extra.the.task.is.in.the.composer.read.it"),
          }
        : offHeadPullRequestCheckoutToast(terminology),
    );
  };

  return { handoff, startAsk, startHandoff };
}
