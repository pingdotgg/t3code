import { setPullRequestCheckoutPending } from "./pullRequestCheckoutState";
import { useAtomCommand } from "~/state/use-atom-command";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
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
  ThreadId,
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
  merge: "Merge requested",
  ready: "Marked ready for review",
  draft: "Converted to draft",
  close: `${capitalizeTerm(term)} closed`,
  reopen: `${capitalizeTerm(term)} reopened`,
  "update-branch": "Branch updated with the base branch",
  "enable-auto-merge": "Auto-merge enabled",
  "disable-auto-merge": "Auto-merge disabled",
  revert: `Revert ${term} opened`,
  "delete-branch": "Branch deleted",
  "approve-workflows": "Workflows approved",
});

const actionFailureLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: `Could not merge this ${term}`,
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: `Could not close this ${term}`,
  reopen: `Could not reopen this ${term}`,
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not enable auto-merge",
  "disable-auto-merge": "Could not disable auto-merge",
  revert: `Could not open a revert ${term}`,
  "delete-branch": "Could not delete this branch",
  "approve-workflows": "Could not approve workflows",
});

const actionFailureHints = (term: string): Record<PullRequestAction, string> => ({
  merge:
    "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ready: "The host refused it. Check that you have write access to this repository.",
  draft: "The host refused it. Check that you have write access to this repository.",
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, and that the branch still exists.",
  "update-branch":
    "The host refused it. Check that you have write access, and that the base branch has not diverged in a way the host cannot merge.",
  "enable-auto-merge":
    "The host refused it. Check that auto-merge is enabled for this repository and that you have write access.",
  "disable-auto-merge": "The host refused it. Check that you have write access to this repository.",
  revert: `The host refused it. Check that you have write access and that this ${term} was merged on the host.`,
  "delete-branch":
    "The host refused it. Check that you have write access to the source repository and that the branch has not moved since this page loaded.",
  "approve-workflows":
    "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
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

export type PullRequestCheckoutPrepared = {
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly isOnPullRequestHead: boolean;
};

type CheckoutHandoffOpened = { readonly draftId: DraftId; readonly threadId: ThreadId };

const CHECKOUT_HANDOFF_TOAST_TIMEOUT_MS = 8_000;

function finishCheckoutHandoffToast(
  toastId: ReturnType<typeof toastManager.add>,
  options: {
    readonly type: "error" | "warning" | "success" | "info";
    readonly title: string;
    readonly description?: string;
  },
) {
  // Base UI merges updates into the loading toast, so clear Cancel and restore a finite timeout.
  toastManager.update(toastId, {
    ...options,
    timeout: CHECKOUT_HANDOFF_TOAST_TIMEOUT_MS,
    actionProps: undefined,
  });
}

/**
 * Opens a thread, puts any task in its composer before checkout finishes, then prepares the
 * branch. Cancel skips applying the checkout; the prompt stays in the composer.
 */
export async function runPullRequestCheckoutHandoff(input: {
  readonly terminology: ChangeRequestTerminology;
  readonly mode: "worktree" | "local";
  readonly task: PullRequestThreadTask | null;
  readonly openThread: () => Promise<CheckoutHandoffOpened | null>;
  readonly prepare: (
    threadId: ThreadId,
  ) => Promise<AtomCommandResult<PullRequestCheckoutPrepared, unknown>>;
  readonly pointThread: (
    prepared: PullRequestCheckoutPrepared,
    opened: CheckoutHandoffOpened,
  ) => Promise<boolean>;
  readonly clearHandoff: () => void;
}): Promise<void> {
  // Explicit timeouts survive toast updates and would pin the result after loading.
  let cancelled = false;
  let settled = false;
  const toastId = toastManager.add({
    type: "loading",
    title: `Preparing the ${input.terminology.singular} checkout...`,
    timeout: 0,
    actionProps: {
      children: "Cancel",
      onClick: () => {
        if (cancelled || settled) return;
        cancelled = true;
        input.clearHandoff();
        finishCheckoutHandoffToast(toastId, {
          type: "info",
          title: "Stopped applying the checkout",
          description:
            input.task === null
              ? "The thread is still open."
              : "The prompt is still in the composer.",
        });
      },
    },
    data: { hideCopyButton: true },
  });

  const opened = await input.openThread();
  // Cancel promises the prompt stays in the composer, so seed even after a cancel during open.
  if (opened !== null && input.task !== null) {
    writeHandoffToComposer(opened.draftId, input.task);
  }
  if (cancelled) return;
  if (opened === null) {
    settled = true;
    input.clearHandoff();
    finishCheckoutHandoffToast(toastId, {
      type: "error",
      title: "Could not open a thread for the checkout",
      description: "Try again from the project, or open a thread first.",
    });
    return;
  }

  setPullRequestCheckoutPending(opened.draftId, true);
  try {
    const prepared = await input.prepare(opened.threadId);
    if (cancelled) return;
    if (prepared._tag === "Failure") {
      settled = true;
      input.clearHandoff();
      finishCheckoutHandoffToast(toastId, {
        type: "error",
        title: `Could not prepare the ${input.terminology.singular} checkout`,
        description: checkoutFailureDescription(
          isAtomCommandInterrupted(prepared) ? undefined : squashAtomCommandFailure(prepared),
        ),
      });
      return;
    }

    const pointed = await input.pointThread(prepared.value, opened);
    if (cancelled) return;
    settled = true;
    if (!pointed) {
      input.clearHandoff();
      finishCheckoutHandoffToast(toastId, {
        type: "error",
        title: "Checked out, but the thread stayed where it was",
        description: `The checkout is ready on \`${prepared.value.branch}\`. Point a thread at it from the branch picker, then ask again.`,
      });
      return;
    }

    input.clearHandoff();
    if (input.task === null) {
      finishCheckoutHandoffToast(
        toastId,
        prepared.value.isOnPullRequestHead
          ? {
              type: "success",
              title: input.mode === "local" ? "Checked out here" : "Checked out",
              description:
                input.mode === "local"
                  ? `This repository is on the ${input.terminology.singular}'s branch, with a thread open on it.`
                  : `The ${input.terminology.singular} is in its own worktree, with a thread open on it.`,
            }
          : offHeadPullRequestCheckoutToast(input.terminology),
      );
      return;
    }
    finishCheckoutHandoffToast(
      toastId,
      prepared.value.isOnPullRequestHead
        ? {
            type: "success",
            title: "Checkout ready",
            description: "The task is in the composer. Read it over, then send.",
          }
        : offHeadPullRequestCheckoutToast(input.terminology),
    );
  } finally {
    setPullRequestCheckoutPending(opened.draftId, false);
  }
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
    task: PullRequestThreadTask | null,
    mode: "worktree" | "local" = "worktree",
  ) => {
    if (!detail || handoff !== null) return;
    setHandoff(kind);
    const projectRef = scopeProjectRef(environmentId, detail.projectId);
    await runPullRequestCheckoutHandoff({
      terminology,
      mode,
      task,
      clearHandoff: () => setHandoff(null),
      // Checkout setup requires the thread to exist first.
      openThread: () =>
        newThread(projectRef).then(
          (session) => session,
          () => null,
        ),
      prepare: (threadId) =>
        prepareThread.run({
          reference: detail.url,
          mode,
          threadId,
        }),
      // Rebind the opened draft: newThread would open a second empty draft once the prompt is seeded.
      pointThread: async (prepared, opened) =>
        useComposerDraftStore.getState().setDraftThreadContext(opened.draftId, {
          branch: prepared.branch,
          worktreePath: prepared.worktreePath,
          envMode: prepared.worktreePath === null ? "local" : "worktree",
        }),
    });
  };

  return { handoff, startAsk, startHandoff };
}
