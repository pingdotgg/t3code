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
import { msg } from "gt-react";
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

import { m } from "~/i18n/messages";

import { toastManager } from "../ui/toast";
import { offHeadPullRequestCheckoutToast } from "./pullRequestCheckoutToast";
import {
  checkoutFailureDescription,
  appendHandoff,
  readableFailure,
} from "./pullRequestDetail.logic";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

import { changeRequestTermKind, type ChangeRequestTermKind } from "./changeRequestTerm";

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

const actionSuccessLabels = (term: ChangeRequestTermKind): Record<PullRequestAction, string> => ({
  merge: m(msg("Merge requested")),
  ready: m(msg("Marked ready for review")),
  draft: m(msg("Converted to draft")),
  close: m(
    msg("{term, select, mr {Merge request} cr {Change request} other {Pull request}} closed", {
      term,
    }),
  ),
  reopen: m(
    msg("{term, select, mr {Merge request} cr {Change request} other {Pull request}} reopened", {
      term,
    }),
  ),
  "update-branch": m(msg("Branch updated with the base branch")),
  "enable-auto-merge": m(msg("Auto-merge enabled")),
  "disable-auto-merge": m(msg("Auto-merge disabled")),
  revert: m(
    msg(
      "Revert {term, select, mr {merge request} cr {change request} other {pull request}} opened",
      { term },
    ),
  ),
  "delete-branch": m(msg("Branch deleted")),
  "approve-workflows": m(msg("Workflows approved")),
});

const actionFailureLabels = (term: ChangeRequestTermKind): Record<PullRequestAction, string> => ({
  merge: m(
    msg(
      "Could not merge this {term, select, mr {merge request} cr {change request} other {pull request}}",
      { term },
    ),
  ),
  ready: m(msg("Could not mark this ready for review")),
  draft: m(msg("Could not convert this to a draft")),
  close: m(
    msg(
      "Could not close this {term, select, mr {merge request} cr {change request} other {pull request}}",
      { term },
    ),
  ),
  reopen: m(
    msg(
      "Could not reopen this {term, select, mr {merge request} cr {change request} other {pull request}}",
      { term },
    ),
  ),
  "update-branch": m(msg("Could not update this branch")),
  "enable-auto-merge": m(msg("Could not enable auto-merge")),
  "disable-auto-merge": m(msg("Could not disable auto-merge")),
  revert: m(
    msg(
      "Could not open a revert {term, select, mr {merge request} cr {change request} other {pull request}}",
      { term },
    ),
  ),
  "delete-branch": m(msg("Could not delete this branch")),
  "approve-workflows": m(msg("Could not approve workflows")),
});

const actionFailureHints = (term: ChangeRequestTermKind): Record<PullRequestAction, string> => ({
  merge: m(
    msg(
      "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
    ),
  ),
  ready: m(msg("The host refused it. Check that you have write access to this repository.")),
  draft: m(msg("The host refused it. Check that you have write access to this repository.")),
  close: m(msg("The host refused it. Check that you have write access, or that you opened it.")),
  reopen: m(
    msg("The host refused it. Check that you have write access, and that the branch still exists."),
  ),
  "update-branch": m(
    msg(
      "The host refused it. Check that you have write access, and that the base branch has not diverged in a way the host cannot merge.",
    ),
  ),
  "enable-auto-merge": m(
    msg(
      "The host refused it. Check that auto-merge is enabled for this repository and that you have write access.",
    ),
  ),
  "disable-auto-merge": m(
    msg("The host refused it. Check that you have write access to this repository."),
  ),
  revert: m(
    msg(
      "The host refused it. Check that you have write access and that this {term, select, mr {merge request} cr {change request} other {pull request}} was merged on the host.",
      { term },
    ),
  ),
  "delete-branch": m(
    msg(
      "The host refused it. Check that you have write access to the source repository and that the branch has not moved since this page loaded.",
    ),
  ),
  "approve-workflows": m(
    msg(
      "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
    ),
  ),
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
  const pendingRef = useRef(new Map<string, PullRequestAction>());
  const [pendingActions, setPendingActions] = useState<ReadonlyMap<string, PullRequestAction>>(
    () => new Map(),
  );
  const actionKey =
    reference === null
      ? null
      : JSON.stringify([
          environmentId,
          reference.projectId,
          reference.host ?? null,
          reference.repository,
          reference.number,
        ]);
  const pendingAction = actionKey === null ? null : (pendingActions.get(actionKey) ?? null);
  const actionPending = pendingAction !== null;

  const perform = async (action: PullRequestAction, method?: PullRequestMergeMethod) => {
    if (actionKey === null || reference === null || pendingRef.current.has(actionKey)) return;
    pendingRef.current.set(actionKey, action);
    setPendingActions(new Map(pendingRef.current));
    const result = await runAction({
      environmentId,
      input: {
        ...reference,
        action,
        ...(method ? { mergeMethod: method } : resolveMergeMethod ? { resolveMergeMethod } : {}),
      },
    });
    pendingRef.current.delete(actionKey);
    setPendingActions(new Map(pendingRef.current));
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: actionFailureLabels(changeRequestTermKind(terminology))[action],
        description: readableFailure(
          squashAtomCommandFailure(result),
          actionFailureHints(changeRequestTermKind(terminology))[action],
        ),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: actionSuccessLabels(changeRequestTermKind(terminology))[action],
    });
    onSuccess?.(action, result.value);
  };

  return { actionPending, pendingAction, perform };
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
            `#${entry.number}: ${readableFailure(squashAtomCommandFailure(result), actionFailureHints(changeRequestTermKind(sourceControlClients.get(entry.provider).changeRequest)).close)}`,
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
          ? m(msg("Closed {closed} of {total} pull requests", { closed, total: batch.length }))
          : m(
              msg(
                "{closed, plural, one {Closed {closed} pull request} other {Closed {closed} pull requests}}",
                { closed },
              ),
            ),
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
        title: m(msg("Could not open a thread")),
        description: m(msg("Try again from the project, or open a thread first.")),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: m(msg("Asked in a thread")),
      description:
        task.prompt.length > 0
          ? m(msg("The question is in the composer. Read it over, then send."))
          : m(
              msg(
                "The {term, select, mr {merge request} cr {change request} other {pull request}} is in the composer. Type your question, then send.",
                {
                  term: changeRequestTermKind(terminology),
                },
              ),
            ),
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
      title: m(
        msg(
          "Preparing the {term, select, mr {merge request} cr {change request} other {pull request}} checkout...",
          { term: changeRequestTermKind(terminology) },
        ),
      ),
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
        title: m(msg("Could not open a thread for the checkout")),
        description: m(msg("Try again from the project, or open a thread first.")),
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
        title: m(
          msg(
            "Could not prepare the {term, select, mr {merge request} cr {change request} other {pull request}} checkout",
            { term: changeRequestTermKind(terminology) },
          ),
        ),
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
        title: m(msg("Checked out, but the thread stayed where it was")),
        description: m(
          msg(
            "The checkout is ready on `{branch}`. Point a thread at it from the branch picker, then ask again.",
            { branch: prepared.value.branch },
          ),
        ),
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
              title: mode === "local" ? m(msg("Checked out here")) : m(msg("Checked out")),
              description:
                mode === "local"
                  ? m(
                      msg(
                        "This repository is on the {term, select, mr {merge request} cr {change request} other {pull request}}'s branch, with a thread open on it.",
                        {
                          term: changeRequestTermKind(terminology),
                        },
                      ),
                    )
                  : m(
                      msg(
                        "The {term, select, mr {merge request} cr {change request} other {pull request}} is in its own worktree, with a thread open on it.",
                        {
                          term: changeRequestTermKind(terminology),
                        },
                      ),
                    ),
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
            title: m(msg("Checkout ready")),
            description: m(msg("The task is in the composer. Read it over, then send.")),
          }
        : offHeadPullRequestCheckoutToast(terminology),
    );
  };

  return { handoff, startAsk, startHandoff };
}
