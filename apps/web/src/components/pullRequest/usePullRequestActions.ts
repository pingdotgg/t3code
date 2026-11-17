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

import { translateDynamic } from "../../i18nCore";

const td = (key: string, options?: Record<string, unknown>) =>
  translateDynamic(`pullRequest:${key}`, options);

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
  merge: td("quickToast.mergeRequested"),
  ready: td("quickToast.markedReady"),
  draft: td("quickToast.convertedToDraft"),
  close: td("quickToast.termClosed", { term }),
  reopen: td("quickToast.termReopened", { term }),
  "update-branch": td("quickToast.branchUpdated"),
  "enable-auto-merge": td("quickToast.autoMergeEnabled"),
  "disable-auto-merge": td("quickToast.autoMergeDisabled"),
  revert: td("toasts.revertOpened", { term }),
  "delete-branch": td("toasts.branchDeleted"),
  "approve-workflows": td("quickToast.workflowsApproved"),
});

const actionFailureLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: td("actionFailure.merge", { term }),
  ready: td("actionFailure.ready"),
  draft: td("actionFailure.draft"),
  close: td("actionFailure.close", { term }),
  reopen: td("actionFailure.reopen", { term }),
  "update-branch": td("actionFailure.updateBranch"),
  "enable-auto-merge": td("quickToast.couldNotEnableAutoMerge"),
  "disable-auto-merge": td("actionFailure.disableAutoMerge"),
  revert: td("actionFailure.revert", { term }),
  "delete-branch": td("actionFailure.deleteBranch"),
  "approve-workflows": td("actionFailure.approveWorkflows"),
});

const actionFailureHints = (term: string): Record<PullRequestAction, string> => ({
  merge: td("actionFailureHint.merge"),
  ready: td("actionFailureHint.ready"),
  draft: td("actionFailureHint.ready"),
  close: td("actionFailureHint.close"),
  reopen: td("actionFailureHint.reopen"),
  "update-branch": td("quickToast.updateBranchHint"),
  "enable-auto-merge": td("quickToast.enableAutoMergeHint"),
  "disable-auto-merge": td("actionFailureHint.disableAutoMerge"),
  revert: td("actionFailureHint.revert", { term }),
  "delete-branch": td("actionFailureHint.deleteBranch"),
  "approve-workflows": td("actionFailureHint.approveWorkflows"),
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
          ? `Closed ${closed} of ${batch.length} pull requests`
          : `Closed ${closed} pull request${closed === 1 ? "" : "s"}`,
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
        title: td("errors.openThread"),
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: td("toasts.askedInThread"),
      description:
        task.prompt.length > 0
          ? td("toasts.composerQuestion")
          : `The ${terminology.singular} is in the composer. Type your question, then send.`,
    });
  };

  const startHandoff = async (
    kind: string,
    task: PullRequestThreadTask | null,
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    // Dismissing the loading toast cancels the handoff before it touches a draft.
    let cancelled = false;
    // Explicit timeouts survive toast updates and would pin the result after loading.
    const toastId = toastManager.add({
      type: "loading",
      title: `Preparing the ${terminology.singular} checkout...`,
      data: {
        onClose: () => {
          cancelled = true;
        },
      },
    });
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    // Checkout setup requires the thread to exist first.
    const opened = await newThread(projectRef).then(
      (session) => session,
      () => null,
    );
    if (cancelled) {
      setHandoff(null);
      return;
    }
    if (opened === null) {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: td("errors.openThreadForCheckout"),
        description: "Try again from the project, or open a thread first.",
      });
      return;
    }
    const prepared = await prepareThread.run({
      reference: detail.url,
      mode,
      threadId: opened.threadId,
    });
    if (cancelled) {
      setHandoff(null);
      return;
    }
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
      (session) => session,
      () => null,
    );
    if (cancelled) {
      setHandoff(null);
      return;
    }
    if (pointed === null) {
      setHandoff(null);
      toastManager.update(toastId, {
        type: "error",
        title: td("toasts.checkedOutThreadStuck"),
        description: `The checkout is ready on \`${prepared.value.branch}\`. Point a thread at it from the branch picker, then ask again.`,
      });
      return;
    }
    // The draft carries the pull request until its first send makes it a thread, which links it.
    useComposerDraftStore.getState().setDraftThreadContext(pointed.draftId, {
      checkoutPullRequest: {
        url: prepared.value.pullRequest.url,
        branch: prepared.value.branch,
      },
    });
    setHandoff(null);
    if (task === null) {
      toastManager.update(
        toastId,
        prepared.value.isOnPullRequestHead
          ? {
              type: "success",
              title: mode === "local" ? td("toasts.checkedOutHere") : td("toasts.checkedOut"),
              description:
                mode === "local"
                  ? `This repository is on the ${terminology.singular}'s branch, with a thread open on it.`
                  : `The ${terminology.singular} is in its own worktree, with a thread open on it.`,
            }
          : offHeadPullRequestCheckoutToast(terminology),
      );
      return;
    }
    // The task goes on the checkout draft: if the user typed into `opened` while the
    // checkout ran, that is no longer the draft the user is looking at.
    await openThreadWithTask(projectRef, task, pointed);
    toastManager.update(
      toastId,
      prepared.value.isOnPullRequestHead
        ? {
            type: "success",
            title: td("toasts.checkoutReady"),
            description: td("toasts.composerTask"),
          }
        : offHeadPullRequestCheckoutToast(terminology),
    );
  };

  return { handoff, startAsk, startHandoff };
}
