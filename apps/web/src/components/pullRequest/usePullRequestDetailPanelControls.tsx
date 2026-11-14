import {
  type EnvironmentId,
  type PullRequestAction,
  type PullRequestMergeMethod,
} from "@t3tools/contracts";

import { readLocalApi } from "~/localApi";

import {
  PullRequestCheckoutMenu,
  PullRequestResolveConflictsButton,
} from "./PullRequestDetailActions";

import type { PullRequestAgentSelectionInput } from "./PullRequestCodeTab";

import {
  buildAddSelectionToAgentHandoff,
  buildFixFindingHandoff,
  buildFixFindingsHandoff,
  buildResolveConflictsPrompt,
  latestPullRequestReviewOutcomes,
  pullRequestFindingKey,
  PULL_REQUEST_MERGE_METHOD_LABELS,
  resolvePullRequestPrimaryControl,
  allowedPullRequestMergeMethods,
  canDeletePullRequestBranch,
  isPullRequestConflicting,
  resolveBaseFreshness,
  resolvePullRequestMergeMethod,
  type PullRequestFinding,
} from "./pullRequestDetail.logic";

import {
  pullRequestChecksState,
  pullRequestChecksStatePresentation,
  resolvePullRequestState,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";

import { TABS } from "./pullRequestDetailPanelShared";

import type { PullRequestDetailPanelActions } from "./usePullRequestDetailPanelActions";

/**
 * What the detail panel offers on this pull request right now: the checkout, merge and conflict
 * controls, resolved from the detail's state and capabilities.
 */
export function usePullRequestDetailPanelControls(prev: PullRequestDetailPanelActions) {
  const {
    actingEnvironmentId,
    attachTarget,
    canMergeSinglePullRequest,
    canPrepareWorktree,
    checkoutRoot,
    context,
    detail,
    environmentId,
    environments,
    handoff,
    handoffSummary,
    isTabAvailable,
    lastSelectedMergeMethod,
    mergeMethodSelection,
    perform,
    pickableEnvironments,
    prepareThread,
    projectDefaultMergeMethod,
    pullRequestKey,
    setActingScope,
    setLastSelectedMergeMethod,
    setMergeMethod,
    sharedSummary,
    stackOwnsMerge,
    startAsk,
    startHandoff,
    terminology,
  } = prev;
  const addSelectionToAgent = (
    selection: PullRequestAgentSelectionInput,
    options?: { readonly keepGuide?: boolean },
  ) => {
    if (!detail) return;
    void startAsk(
      `selection:${selection.comment.id}`,
      buildAddSelectionToAgentHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        state: detail.state,
        isDraft: detail.isDraft,
        comment: selection.comment,
        request: selection.request,
      }),
      options,
    );
  };

  const startCheckout = (mode: "worktree" | "local") => {
    if (!handoffSummary) return;
    void startHandoff(`checkout:${mode}`, null, mode);
  };

  const startFixFinding = (finding: PullRequestFinding) => {
    if (!detail) return;
    void startHandoff(
      pullRequestFindingKey(finding),
      buildFixFindingHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        finding,
      }),
    );
  };

  const startFixFindings = () => {
    if (!detail) return;
    void startHandoff(
      "findings",
      buildFixFindingsHandoff({
        number: detail.number,
        title: detail.title,
        url: detail.url,
        headBranch: detail.headBranch,
        baseBranch: detail.baseBranch,
        reviewThreads: detail.reviewThreads,
        comments: detail.comments,
        checks: checksStale ? [] : detail.checks,
        commentsTruncated: detail.commentsTruncated,
      }),
    );
  };

  const startResolveConflicts = () => {
    if (!handoffSummary) return;
    void startHandoff("conflicts", {
      prompt: buildResolveConflictsPrompt({
        number: handoffSummary.number,
        url: handoffSummary.url,
        headBranch: handoffSummary.headBranch,
        baseBranch: handoffSummary.baseBranch,
      }),
    });
  };

  const selectMergeMethod = (method: PullRequestMergeMethod) => {
    setMergeMethod(method);
    setLastSelectedMergeMethod(method);
  };
  const selectActingEnvironment = (next: EnvironmentId) =>
    setActingScope({ pullRequestKey, environmentId: next });
  const allowedMergeMethods = allowedPullRequestMergeMethods(detail);
  const currentMergeMethod =
    mergeMethodSelection?.pullRequestKey === pullRequestKey ? mergeMethodSelection.method : null;
  const selectedMergeMethod = resolvePullRequestMergeMethod(
    allowedMergeMethods,
    currentMergeMethod,
    projectDefaultMergeMethod,
    lastSelectedMergeMethod,
  );
  const selectedMergeMethodLabel = PULL_REQUEST_MERGE_METHOD_LABELS[selectedMergeMethod];
  const pendingAutoMergeLabel = `Auto-merge (${selectedMergeMethodLabel.toLowerCase()})`;
  const conflicting = isPullRequestConflicting(detail);
  const autoMergeArmed = detail?.state === "open" && detail.autoMergeEnabled === true;
  const armedMergeMethod = detail?.autoMergeMethod;
  const armedAutoMergeLabel = armedMergeMethod
    ? `Auto-merge (${PULL_REQUEST_MERGE_METHOD_LABELS[armedMergeMethod].toLowerCase()})`
    : "Auto-merge";
  const workflowApprovalsRequired =
    detail?.state === "open" ? (detail.workflowApprovalsRequired ?? 0) : 0;
  const freshness = detail === null ? null : resolveBaseFreshness(detail);
  const visibleTabs = TABS.filter((item) => isTabAvailable(item.value));
  const can = (action: PullRequestAction) =>
    detail?.capabilities.actions.includes(action) === true &&
    detail.viewerPermissions.actions.includes(action);
  const detailChecksState = detail ? pullRequestChecksState(detail.checks) : null;
  const latestChecksState =
    sharedSummary?.checksState === undefined ? detailChecksState : sharedSummary.checksState;
  // List rollups can omit workflows awaiting approval. Only refreshed detail can clear those.
  const checksState =
    latestChecksState !== "failing" &&
    detail?.checks.some((check) => check.status === "action-required")
      ? "pending"
      : latestChecksState;
  const checksStale = checksState !== detailChecksState;
  const primaryAction = detail
    ? resolvePullRequestPrimaryControl({
        state: detail.state,
        isDraft: detail.isDraft,
        mergeability: detail.mergeability,
        checksState,
        autoMergeEnabled: detail.autoMergeEnabled,
        hasMergeMethod: allowedMergeMethods.length > 0,
        canMerge: !stackOwnsMerge && can("merge"),
        canMarkReady: can("ready"),
        canEnableAutoMerge: !stackOwnsMerge && can("enable-auto-merge"),
      })
    : null;
  const showsDraftToggle =
    detail?.state === "open" &&
    can(detail.isDraft ? "ready" : "draft") &&
    !(detail.isDraft && primaryAction === "ready");
  const showsAutoMerge =
    canMergeSinglePullRequest &&
    detail?.state === "open" &&
    ((autoMergeArmed && can("disable-auto-merge")) ||
      (!autoMergeArmed &&
        primaryAction !== "enable-auto-merge" &&
        !detail.isDraft &&
        !conflicting &&
        can("enable-auto-merge") &&
        allowedMergeMethods.length > 0));
  const showsMergeNow =
    canMergeSinglePullRequest &&
    detail?.state === "open" &&
    (primaryAction === "enable-auto-merge" || primaryAction === "auto-merge-armed") &&
    can("merge") &&
    !detail.isDraft &&
    !conflicting &&
    allowedMergeMethods.length > 0;
  const showsMergeMethods =
    detail?.state === "open" &&
    can("merge") &&
    !detail.isDraft &&
    !conflicting &&
    allowedMergeMethods.length > 1;
  const statePresentation = detail
    ? resolvePullRequestState({ state: detail.state, isDraft: detail.isDraft })
    : null;
  const showsDeleteBranch = detail !== null && canDeletePullRequestBranch(detail);
  const environmentConnected = environments.some(
    (environment) =>
      environment.environmentId === environmentId && environment.connection.phase === "connected",
  );
  const confirmDeleteBranch = async () => {
    if (detail === null) return;
    const confirmed = await readLocalApi()?.dialogs.confirm(
      [
        `Delete branch ${detail.headBranch}?`,
        `This deletes ${detail.headBranch} from ${detail.headRepositoryNameWithOwner ?? detail.repository}. Local branches and worktrees are not changed.`,
      ].join("\n"),
      { variant: "destructive" },
    );
    if (confirmed) void perform("delete-branch");
  };
  const showsApproveWorkflows =
    workflowApprovalsRequired > 0 && !checksStale && can("approve-workflows");
  const checksSummary = checksStale
    ? checksState === null
      ? "No checks reported"
      : pullRequestChecksStatePresentation(checksState).label
    : detail
      ? summarizePullRequestChecks(detail.checks)
      : null;
  const approvalCount =
    detail && !detail.commentsTruncated
      ? latestPullRequestReviewOutcomes(detail.comments, detail.commits).filter(
          (entry) => entry.outcome === "approved" && !entry.stale,
        ).length
      : 0;

  const checkoutControl =
    context === "page" ? (
      <PullRequestCheckoutMenu
        term={terminology.singular}
        handoff={handoff}
        checkoutRoot={checkoutRoot}
        canPrepareWorktree={canPrepareWorktree}
        canCheckoutHere={prepareThread.isAllowed}
        onCheckout={startCheckout}
        pickableEnvironments={pickableEnvironments}
        actingEnvironmentId={actingEnvironmentId}
        onActingEnvironmentChange={selectActingEnvironment}
      />
    ) : null;

  const resolveConflictsControl = (
    <PullRequestResolveConflictsButton
      handoff={handoff}
      unavailable={attachTarget === null && (checkoutRoot === null || !canPrepareWorktree)}
      onResolve={startResolveConflicts}
    />
  );

  return {
    ...prev,
    addSelectionToAgent,
    allowedMergeMethods,
    approvalCount,
    armedAutoMergeLabel,
    autoMergeArmed,
    can,
    checkoutControl,
    checksStale,
    checksState,
    checksSummary,
    confirmDeleteBranch,
    conflicting,
    environmentConnected,
    freshness,
    pendingAutoMergeLabel,
    primaryAction,
    resolveConflictsControl,
    selectActingEnvironment,
    selectMergeMethod,
    selectedMergeMethod,
    selectedMergeMethodLabel,
    showsApproveWorkflows,
    showsAutoMerge,
    showsDeleteBranch,
    showsDraftToggle,
    showsMergeMethods,
    showsMergeNow,
    startFixFinding,
    startFixFindings,
    statePresentation,
    visibleTabs,
  };
}

export type PullRequestDetailPanelState = ReturnType<typeof usePullRequestDetailPanelControls>;
