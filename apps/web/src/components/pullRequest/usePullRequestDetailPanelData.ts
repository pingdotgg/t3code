import { projectChangeRequestUrl } from "@t3tools/client-runtime/change-request-links";
import { normalizeThreadPullRequestKey } from "@t3tools/client-runtime/thread-pull-requests";
import { useAtomValue } from "@effect/atom-react";
import { usePullRequestStack } from "~/state/usePullRequestStack";

import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type PullRequestAction,
  type PullRequestMergeMethod,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { type PullRequestDetailTab } from "~/rightPanelStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { usePullRequestDefaultMergeMethodResolver } from "./usePullRequestActions";

import { usePreparePullRequestThreadAction } from "~/state/sourceControlActions";

import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { pullRequestEnvironment, usePullRequestTurnRefresh } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";

import { vcsEnvironment } from "~/state/vcs";

import { useUiStateStore } from "~/uiStateStore";

import { toastManager } from "../ui/toast";

import { pullRequestRefKey, usePullRequestDetail } from "./usePullRequestDetail";

import { openOnHostLabel } from "./pullRequestLinkContextMenu";

import {
  loadingPullRequestCheckoutCommand,
  isStackedPullRequestBase,
  pullRequestCheckoutCommand,
  allowsSinglePullRequestMerge,
  shouldRefreshPullRequestActivity,
} from "./pullRequestDetail.logic";
import { resolvePickableEnvironments } from "./pullRequestProjectAssignment.logic";

import { guideRunKey, useGuideRunStore } from "./guide/guideRunStore";

import {
  loadCodeTab,
  pullRequestMarkdownContext,
  pullRequestStackReference,
  resolvePullRequestReference,
} from "./pullRequestDetailPanelShared";

import { PullRequestDetailPanelProps } from "./pullRequestDetailPanelTypes";

/**
 * The detail panel's data: the resolved reference, queries, tab state, merge-method choice, and
 * refresh plumbing. Everything below it renders from this.
 */
export function usePullRequestDetailPanelData(props: PullRequestDetailPanelProps) {
  const {
    environmentId,
    shortcutsEnabled,
    getShortcutContext,
    threadRef = null,
    reference: requestedReference,
    listEntry = null,
    refreshToken: forcedRefreshToken = 0,
    tabOnPage = false,
    onActed,
    onClose,
    context = "page",
    composerDraftTarget,
    onBack,
    onSelectPullRequest,
    onGuideShown,
    initialTab = "summary",
    onTabChange,
  } = props;
  const environmentConfigs = useServerConfigs();
  const projects = useProjects();
  const project = projects.find(
    (project) =>
      project.id === requestedReference.projectId && project.environmentId === environmentId,
  );
  const repositoryIdentity = project?.repositoryIdentity;
  const supportsThreadPullRequests = environmentConfigs.get(environmentId) !== undefined;
  const reference = resolvePullRequestReference(
    requestedReference,
    repositoryIdentity,
    supportsThreadPullRequests,
  );
  const loadingCheckoutCommand = loadingPullRequestCheckoutCommand(reference, repositoryIdentity);
  const unavailableHostUrl = projectChangeRequestUrl(
    repositoryIdentity,
    reference.repository,
    reference.number,
  );
  const pullRequestKey = pullRequestRefKey(reference);
  const matchingListEntry =
    listEntry?.projectId === reference.projectId &&
    listEntry.repository.toLowerCase() === reference.repository.toLowerCase() &&
    (reference.host === undefined ||
      listEntry.host.toLowerCase() === reference.host.toLowerCase()) &&
    listEntry.number === reference.number
      ? listEntry
      : null;
  const linkedReference = sourceControlClients.parseChangeRequestUrl(
    matchingListEntry?.url ?? unavailableHostUrl ?? "",
  )?.link;
  useEnvironmentQuery(
    context === "page" &&
      supportsThreadPullRequests &&
      linkedReference &&
      (reference.host === undefined ||
        reference.host.toLowerCase() === linkedReference.host.toLowerCase())
      ? pullRequestEnvironment.linkedThreads({
          environmentId,
          input: { ...reference, ...normalizeThreadPullRequestKey(linkedReference) },
        })
      : null,
  );
  useEnvironmentQuery(pullRequestEnvironment.changeBreakdown({ environmentId, input: reference }));
  const [threadPickerOpen, setThreadPickerOpen] = useState(false);
  const [openReviewRequest, setOpenReviewRequest] = useState(0);
  const {
    canWriteSourceControl,
    detailQuery,
    activityQuery,
    activity,
    sharedSummary,
    coreDetail,
    detail,
  } = usePullRequestDetail(environmentId, reference, matchingListEntry);
  const [selectedTab, setTab] = useState<PullRequestDetailTab>(initialTab);
  const reviewGuidesEnabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.reviewGuidesEnabled,
  );
  const guideKey = guideRunKey(environmentId, reference);
  const pageTab = useGuideRunStore((state) =>
    tabOnPage && state.pageDetailTab?.key === guideKey ? state.pageDetailTab.tab : null,
  );
  const requestedTab = tabOnPage ? (pageTab ?? initialTab) : selectedTab;
  const isTabAvailable = (value: PullRequestDetailTab) =>
    (value !== "code" || detail === null || detail.capabilities.diff) &&
    (value !== "guide" || reviewGuidesEnabled);
  // An unavailable tab falls back without overwriting the saved selection.
  const tab = isTabAvailable(requestedTab) ? requestedTab : "summary";
  const selectTab = (next: PullRequestDetailTab) => {
    if (tabOnPage) useGuideRunStore.getState().showPageDetailTab(guideKey, next);
    else setTab(next);
    onTabChange?.(next);
  };
  const [timelineOrder, setTimelineOrder] = useState<"newest" | "oldest">("newest");
  const [codeCommitScope, setCodeCommitScope] = useState<{
    readonly pullRequestKey: string;
    readonly oid: string | null;
  }>(() => ({ pullRequestKey, oid: null }));
  const selectedCodeCommitOid =
    codeCommitScope.pullRequestKey === pullRequestKey ? codeCommitScope.oid : null;
  const selectCodeCommit = (oid: string | null) => {
    setCodeCommitScope({ pullRequestKey, oid });
  };
  const openCommit = (oid: string) => {
    selectCodeCommit(oid);
    selectTab("code");
  };
  const [codeRevealRequest, setCodeRevealRequest] = useState<{
    readonly path: string;
    readonly nonce: number;
  } | null>(null);
  const openFileInCode = (path: string) => {
    selectCodeCommit(null);
    setCodeRevealRequest((previous) => ({ path, nonce: (previous?.nonce ?? 0) + 1 }));
    void loadCodeTab();
    selectTab("code");
  };
  const tabScopeKey = `${environmentId}:${pullRequestKey}`;
  const [tabMountState, setTabMountState] = useState(() => ({
    key: tabScopeKey,
    tabs: new Set<PullRequestDetailTab>([tab]),
  }));
  // Hidden Code tabs must not fetch later pull requests' diffs.
  const mountedTabs =
    tabMountState.key === tabScopeKey ? tabMountState.tabs : new Set<PullRequestDetailTab>([tab]);
  if (tabMountState.key !== tabScopeKey) {
    setTabMountState({ key: tabScopeKey, tabs: new Set([tab]) });
  } else if (!tabMountState.tabs.has(tab)) {
    setTabMountState({ key: tabScopeKey, tabs: new Set(tabMountState.tabs).add(tab) });
  }
  // Each tab restores the condensed state its own scrolling left behind.
  const [condensedByTab, setCondensedByTab] = useState<
    Partial<Record<PullRequestDetailTab, boolean>>
  >({});
  const condensed = condensedByTab[tab] ?? false;
  const scrollerByTab = useRef<Partial<Record<PullRequestDetailTab, HTMLElement | null>>>({});
  // Fresh ref callbacks would detach and reattach every scroller on each render.
  const [scrollerRefs] = useState(() => ({
    summary: (node: HTMLElement | null) => {
      scrollerByTab.current.summary = node;
    },
    timeline: (node: HTMLElement | null) => {
      scrollerByTab.current.timeline = node;
    },
    code: (node: HTMLElement | null) => {
      scrollerByTab.current.code = node;
    },
  }));
  const foldRef = useRef<HTMLDivElement | null>(null);
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  // Save the target before collapse: the browser may clamp scrollTop as the viewport grows,
  // so applying a delta afterward would compensate twice.
  const compensationRef = useRef<{
    tab: PullRequestDetailTab;
    scroller: HTMLElement;
    target: number;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restores the scroller's scrollTop before paint after the header condenses
  useLayoutEffect(() => {
    const compensation = compensationRef.current;
    if (compensation === null) return;
    compensationRef.current = null;
    if (
      !condensed ||
      compensation.tab !== tab ||
      scrollerByTab.current[tab] !== compensation.scroller
    )
      return;
    compensation.scroller.scrollTop = Math.max(0, compensation.target);
  }, [condensed, tab]);
  const lastSelectedMergeMethod = useUiStateStore((state) => state.pullRequestMergeMethod);
  const setLastSelectedMergeMethod = useUiStateStore((state) => state.setPullRequestMergeMethod);
  const resolveProjectDefaultMergeMethod = usePullRequestDefaultMergeMethodResolver(
    environmentId,
    reference.projectId,
  );
  const projectDefaultMergeMethod = resolveProjectDefaultMergeMethod();
  const [mergeMethodSelection, setMergeMethodSelection] = useState<{
    readonly pullRequestKey: string;
    readonly method: PullRequestMergeMethod;
  } | null>(null);
  const setMergeMethod = (method: PullRequestMergeMethod) => {
    setMergeMethodSelection({ pullRequestKey, method });
  };
  const [handoff, setHandoff] = useState<string | null>(null);
  const turnRefresh = usePullRequestTurnRefresh(environmentId);
  const handoffSummary = detail ?? sharedSummary;
  const terminology = sourceControlClients.get(
    handoffSummary?.provider ?? listEntry?.provider ?? repositoryIdentity?.provider,
  ).changeRequest;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { copyToClipboard: copyReference } = useCopyToClipboard<string>({
    target: `${terminology.singular} reference`,
    onCopy: (label) => toastManager.add({ type: "success", title: `${label} copied` }),
    onError: (error, label) =>
      toastManager.add({
        type: "error",
        title: `Failed to copy ${label}`,
        description: error.message,
      }),
  });
  const copyFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!shortcutsEnabled || event.defaultPrevented || isCommandPaletteOpen()) return;
    const command = resolveShortcutCommand(event, keybindings, {
      context: getShortcutContext(),
    });
    if (command !== "pullRequest.copyNumber") return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) copyReference(`#${reference.number}`, `${terminology.shortLabel} number`);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window keydown capture listener for the copy-number shortcut
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => copyFromShortcut(event);
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
  const autoMergeKey = `${pullRequestKey}:${detail?.autoMergeMethod ?? ""}`;
  const [seenAutoMergeKey, setSeenAutoMergeKey] = useState<string | null>(null);
  if (seenAutoMergeKey !== autoMergeKey) {
    setSeenAutoMergeKey(autoMergeKey);
    if (detail?.autoMergeMethod !== undefined) setMergeMethod(detail.autoMergeMethod);
  }
  const repositoryUrl =
    detail === null
      ? null
      : (sourceControlClients.parseChangeRequestUrl(detail.url)?.link.repositoryUrl ?? null);
  const hostClient = sourceControlClients.get(detail?.provider);
  const openOnHostText = openOnHostLabel(hostClient);
  const markdownContext = pullRequestMarkdownContext(detail, threadRef);
  const authorProfileUrl =
    detail?.author && repositoryUrl !== null
      ? hostClient.authorProfileUrl(detail.author.login, repositoryUrl)
      : null;
  const checkoutCommand = handoffSummary
    ? pullRequestCheckoutCommand(
        handoffSummary.provider,
        handoffSummary.number,
        handoffSummary.headBranch,
        detail?.headRepositoryNameWithOwner,
        sourceControlClients.parseChangeRequestUrl(handoffSummary.url)?.link.repositoryUrl ?? null,
      )
    : loadingCheckoutCommand;
  const branchRefsQuery = useEnvironmentQuery(
    detail === null
      ? null
      : vcsEnvironment.listRefs({
          environmentId,
          input: {
            cwd: detail.workspaceRoot,
            includeMatchingRemoteRefs: true,
            limit: 2,
          },
        }),
  );
  const isStackedPullRequest =
    detail !== null &&
    isStackedPullRequestBase(detail.baseBranch, branchRefsQuery.data?.refs ?? []);
  const stackReference = pullRequestStackReference(detail, reference, supportsThreadPullRequests);
  const nativeStackQuery = usePullRequestStack(environmentId, stackReference);
  const nativeStack = nativeStackQuery.data;
  const supportsStackActions =
    supportsThreadPullRequests &&
    detail?.capabilities.stacks === true &&
    detail.capabilities.stackActions === true;
  const canMergeSinglePullRequest = allowsSinglePullRequestMerge({
    supportsStackActions,
    hasStack: nativeStack !== null,
    stackPending: !nativeStackQuery.isFresh,
    stackError: nativeStackQuery.error,
  });
  const stackOwnsMerge = supportsStackActions && nativeStack !== null;
  const mergeBlockedReason = canMergeSinglePullRequest
    ? null
    : nativeStackQuery.error
      ? "Couldn't check stack membership"
      : "Checking stack membership…";
  const activityPending = activityQuery.isPending && activity === null;
  const activityError = activity === null ? activityQuery.error : null;
  const refreshDetail = () => {
    detailQuery.refresh();
    activityQuery.refresh();
    nativeStackQuery.refresh();
  };
  const [refreshToken, setRefreshToken] = useState(0);
  const [activityRevision, setActivityRevision] = useState<{
    readonly key: string;
    readonly updatedAt: string;
  } | null>(null);
  const [activityRevalidations, setActivityRevalidations] = useState(0);
  const coreUpdatedAt = coreDetail?.updatedAt ?? null;
  if (
    coreUpdatedAt !== null &&
    (activityRevision?.key !== tabScopeKey || activityRevision.updatedAt !== coreUpdatedAt)
  ) {
    const next = { key: tabScopeKey, updatedAt: coreUpdatedAt };
    if (!shouldRefreshPullRequestActivity(activityRevision, next)) {
      setActivityRevision(next);
    } else if (!activityQuery.isPending) {
      // Interrupting a mutation's activity refresh can leave SWR displaying stale data.
      setActivityRevision(next);
      setActivityRevalidations((count) => count + 1);
      setRefreshToken((token) => token + 1);
    }
  }
  const revalidateActivity = useEffectEvent(() => activityQuery.refresh());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the activity query after commit when render counts a new detail revision
  useEffect(() => {
    if (activityRevalidations > 0) revalidateActivity();
  }, [activityRevalidations]);
  useLiveRefresh(
    () => {
      detailQuery.refresh();
    },
    { key: `pull-request:${environmentId}:${pullRequestKey}` },
  );
  const invalidate = useAtomCommand(pullRequestEnvironment.invalidate, { reportFailure: false });
  const [isInvalidating, setIsInvalidating] = useState(false);
  const refreshing = isInvalidating || detailQuery.isPending;
  const refreshFromHost = async () => {
    setIsInvalidating(true);
    // Atom commands settle without throwing, so reset always runs.
    await invalidate({ environmentId, input: { reference } });
    refreshDetail();
    setRefreshToken((token) => token + 1);
    setIsInvalidating(false);
  };
  const refreshFromHostOnRequest = useEffectEvent(() => void refreshFromHost());
  const appliedForcedToken = useRef(forcedRefreshToken);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a new forced refresh token invalidates the host cache and refetches
  useEffect(() => {
    if (appliedForcedToken.current === forcedRefreshToken) return;
    appliedForcedToken.current = forcedRefreshToken;
    refreshFromHostOnRequest();
  }, [forcedRefreshToken]);
  const runAction = useAtomCommand(pullRequestEnvironment.runAction, {
    reportFailure: false,
  });
  const postComment = useAtomCommand(pullRequestEnvironment.comment, {
    reportFailure: false,
  });
  const [pendingAction, setPendingAction] = useState<PullRequestAction | null>(null);
  const actionPending = pendingAction !== null;
  const newThread = useNewThreadHandler();
  const { environments } = useEnvironments();
  const pickableEnvironments =
    context === "page"
      ? resolvePickableEnvironments(
          { environmentId, projectId: reference.projectId },
          projects,
          environments.map((environment) => ({
            environmentId: environment.environmentId,
            label: environment.label,
            machine: resolveEnvironmentMachineKind(environment.serverConfig),
          })),
        )
      : [];
  const [actingScope, setActingScope] = useState<{
    readonly pullRequestKey: string;
    readonly environmentId: EnvironmentId;
  } | null>(null);
  const chosenEnvironmentId =
    actingScope?.pullRequestKey === pullRequestKey ? actingScope.environmentId : environmentId;
  const acting =
    pickableEnvironments.find((entry) => entry.environmentId === chosenEnvironmentId) ?? null;
  const actingEnvironmentId = acting?.environmentId ?? environmentId;
  const checkoutRoot =
    acting?.workspaceRoot ?? detail?.workspaceRoot ?? project?.workspaceRoot ?? null;
  const canOperateThread = useEnvironmentScope(actingEnvironmentId, AuthOrchestrationOperateScope);
  const prepareThread = usePreparePullRequestThreadAction({
    environmentId: actingEnvironmentId,
    cwd: checkoutRoot,
  });

  return {
    ...props,
    composerDraftTarget,
    context,
    forcedRefreshToken,
    getShortcutContext,
    initialTab,
    listEntry,
    onActed,
    onBack,
    onClose,
    onGuideShown,
    onSelectPullRequest,
    onTabChange,
    requestedReference,
    shortcutsEnabled,
    tabOnPage,
    threadRef,
    acting,
    actingEnvironmentId,
    actionPending,
    activity,
    activityError,
    activityPending,
    activityQuery,
    authorProfileUrl,
    canMergeSinglePullRequest,
    canOperateThread,
    canWriteSourceControl,
    checkoutCommand,
    checkoutRoot,
    codeRevealRequest,
    compensationRef,
    condensed,
    condensedByTab,
    condensedRowRef,
    copyReference,
    detail,
    detailQuery,
    environments,
    foldRef,
    guideKey,
    handoff,
    handoffSummary,
    hostClient,
    isStackedPullRequest,
    isTabAvailable,
    lastSelectedMergeMethod,
    markdownContext,
    matchingListEntry,
    mergeBlockedReason,
    mergeMethodSelection,
    mountedTabs,
    nativeStack,
    nativeStackQuery,
    newThread,
    openCommit,
    openFileInCode,
    openOnHostText,
    openReviewRequest,
    pendingAction,
    pickableEnvironments,
    postComment,
    prepareThread,
    project,
    projectDefaultMergeMethod,
    pullRequestKey,
    reference,
    refreshDetail,
    refreshFromHost,
    refreshToken,
    refreshing,
    repositoryIdentity,
    repositoryUrl,
    reviewGuidesEnabled,
    runAction,
    scrollerByTab,
    scrollerRefs,
    selectCodeCommit,
    selectTab,
    selectedCodeCommitOid,
    setActingScope,
    setCondensedByTab,
    setHandoff,
    setLastSelectedMergeMethod,
    setMergeMethod,
    setOpenReviewRequest,
    setPendingAction,
    setThreadPickerOpen,
    setTimelineOrder,
    sharedSummary,
    stackOwnsMerge,
    supportsStackActions,
    tab,
    terminology,
    threadPickerOpen,
    timelineOrder,
    turnRefresh,
    unavailableHostUrl,
  };
}

export type PullRequestDetailPanelData = ReturnType<typeof usePullRequestDetailPanelData>;
