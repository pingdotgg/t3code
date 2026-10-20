import type { RunId, ScopedThreadRef, ThreadLinkedPullRequest } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useRef } from "react";
import { useDiffPanelStore } from "../diffPanelStore";
import {
  selectActiveRightPanelSurface,
  pullRequestSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import type { TurnDiffSummary } from "../types";
import {
  observeProactivePanelUserChoice,
  shouldApplyProactiveChangesScope,
  resolveProactiveTurnDiffAction,
  shouldOpenProactivePullRequest,
  shouldOpenProactiveTurnDiff,
  shouldRetargetThreadPullRequestPanel,
} from "../components/ChatView.logic";

// Settings and drafts unmount ChatView; remember links until the page reloads.
const observedThreadPullRequests = new Map<string, ThreadLinkedPullRequest | null>();

/**
 * Opens the right panel on its own when there is something new to look at: a
 * change request linked to the thread, or the diff of a turn that just
 * completed. A panel the user opened or closed since wins; see
 * observeProactivePanelUserChoice.
 */
export function useProactivePanels(input: {
  // Null for drafts and while the thread is unavailable.
  readonly threadRef: ScopedThreadRef | null;
  readonly enabled: boolean;
  readonly settingsHydrated: boolean;
  readonly threadDetailLoading: boolean;
  readonly runningTurnId: RunId | null;
  readonly latestRun: { readonly runId: RunId; readonly status: string } | null;
  readonly latestRunSettled: boolean;
  readonly turnDiffSummaries: ReadonlyArray<TurnDiffSummary>;
  readonly isGitRepo: boolean | undefined;
  readonly linkedPullRequest: ThreadLinkedPullRequest | null;
  readonly hasLinkedPullRequestDetail: boolean;
  // Identifies the change requests the thread shows, so a new one can open the panel.
  readonly pullRequestsKey: string | null;
  readonly pullRequestsCapabilityKnown: boolean;
  readonly supportsPullRequests: boolean;
  readonly pullRequestsSurfaceAvailable: boolean;
  readonly visiblePullRequestCount: number;
  readonly onDiffPanelOpen: (() => void) | undefined;
}) {
  const {
    threadRef,
    enabled: proactivePanelsEnabledSetting,
    settingsHydrated: clientSettingsHydrated,
    threadDetailLoading,
    runningTurnId: activeRunningTurnId,
    latestRun: activeLatestRun,
    latestRunSettled,
    turnDiffSummaries,
    isGitRepo,
    linkedPullRequest: linkedThreadPullRequest,
    hasLinkedPullRequestDetail,
    pullRequestsKey: proactivePullRequestsKey,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    onDiffPanelOpen,
  } = input;
  const proactivePanelObservationRef = useRef<ReturnType<
    typeof observeProactivePanelUserChoice
  > | null>(null);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;

  useEffect(() => {
    if (threadKey === null || threadRef === null) {
      proactivePanelObservationRef.current = null;
      return;
    }
    const panels = useRightPanelStore.getState();
    const observation = observeProactivePanelUserChoice(proactivePanelObservationRef.current, {
      threadKey: threadKey,
      runningTurnId: activeRunningTurnId,
      userActionRevision: panels.getUserActionRevision(threadRef),
    });
    proactivePanelObservationRef.current = observation;
    const {
      runningTurnId: previousRunningTurnId,
      targetKey: previousTargetKey,
      userActionRevision,
    } = observation;
    const openSurface = selectActiveRightPanelSurface(panels.byThreadKey, threadRef);
    const previousPullRequest = observedThreadPullRequests.get(threadKey) ?? null;
    // A missing link during loading must not erase the last observed one.
    if (linkedThreadPullRequest !== null || !threadDetailLoading) {
      observedThreadPullRequests.set(threadKey, linkedThreadPullRequest);
    }
    const followSelectedPullRequest = shouldRetargetThreadPullRequestPanel(
      previousPullRequest,
      linkedThreadPullRequest,
      openSurface,
    );
    // Following the selected linked PR does not open an unrelated panel, so it
    // remains available with proactive panels off. It still respects a later choice.
    if (followSelectedPullRequest && linkedThreadPullRequest !== null) {
      panels.openProactive(
        threadRef,
        pullRequestSurface(linkedThreadPullRequest),
        userActionRevision,
        true,
      );
    }
    if (!clientSettingsHydrated) return;

    const proactivePanelsEnabled = proactivePanelsEnabledSetting;
    const eligibleLink =
      proactivePanelsEnabled &&
      shouldOpenProactivePullRequest(previousTargetKey, proactivePullRequestsKey);
    const shouldDeferLink = eligibleLink && !pullRequestsCapabilityKnown;
    proactivePanelObservationRef.current = {
      ...observation,
      targetKey: shouldDeferLink ? (previousTargetKey ?? null) : proactivePullRequestsKey,
    };
    if (eligibleLink && pullRequestsCapabilityKnown) {
      if (
        !followSelectedPullRequest &&
        pullRequestsSurfaceAvailable &&
        (visiblePullRequestCount > 1 || !hasLinkedPullRequestDetail || !supportsPullRequests)
      ) {
        panels.openProactive(
          threadRef,
          { id: "pull-requests", kind: "pull-requests" },
          userActionRevision,
        );
      } else if (
        !followSelectedPullRequest &&
        supportsPullRequests &&
        linkedThreadPullRequest !== null
      ) {
        panels.openProactive(
          threadRef,
          pullRequestSurface(linkedThreadPullRequest),
          userActionRevision,
        );
      }
    }
    if (threadDetailLoading) return;

    const settledTurnId = latestRunSettled ? (activeLatestRun?.runId ?? null) : null;
    const newlyCompletedTurnId = shouldOpenProactiveTurnDiff({
      previousRunningTurnId,
      runningTurnId: activeRunningTurnId,
      settledTurnId,
      turnCompleted: activeLatestRun?.status === "completed",
    })
      ? settledTurnId
      : null;
    const eligibleCompletion =
      proactivePanelsEnabled &&
      newlyCompletedTurnId !== null &&
      !(
        proactivePullRequestsKey !== null &&
        (!pullRequestsCapabilityKnown || supportsPullRequests || pullRequestsSurfaceAvailable)
      );
    const completedCheckpoint = eligibleCompletion
      ? turnDiffSummaries.find((checkpoint) => checkpoint.runId === newlyCompletedTurnId)
      : undefined;
    const diffAction = eligibleCompletion
      ? resolveProactiveTurnDiffAction({
          checkpoint: completedCheckpoint,
          isGitRepo,
        })
      : "ignore";
    proactivePanelObservationRef.current = {
      ...proactivePanelObservationRef.current,
      // Preserve first-entry eligibility while capabilities, checkpoint or repository load.
      runningTurnId:
        diffAction === "defer" || shouldDeferLink ? previousRunningTurnId : activeRunningTurnId,
    };
    if (diffAction !== "open" || newlyCompletedTurnId === null) return;
    const alreadyReviewingDiff = openSurface?.kind === "diff";
    if (
      !panels.openProactive(
        threadRef,
        { kind: "diff", turnId: newlyCompletedTurnId },
        userActionRevision,
      )
    ) {
      return;
    }
    if (shouldApplyProactiveChangesScope({ openedDiff: true, alreadyReviewingDiff })) {
      useDiffPanelStore.getState().selectGitScope(threadRef, "branch");
    }
    onDiffPanelOpen?.();
  }, [
    activeLatestRun?.runId,
    activeLatestRun?.status,
    activeRunningTurnId,
    clientSettingsHydrated,
    hasLinkedPullRequestDetail,
    isGitRepo,
    latestRunSettled,
    linkedThreadPullRequest,
    onDiffPanelOpen,
    proactivePanelsEnabledSetting,
    proactivePullRequestsKey,
    pullRequestsCapabilityKnown,
    pullRequestsSurfaceAvailable,
    supportsPullRequests,
    threadDetailLoading,
    threadKey,
    threadRef,
    turnDiffSummaries,
    visiblePullRequestCount,
  ]);
}
