import { usePullRequestDetail, pullRequestRefKey } from "./usePullRequestDetail";
import { PullRequestDetailCrumbs } from "./PullRequestDetailCrumbs";
import { PullRequestTitleEditor } from "./PullRequestTitleEditor";
import { PullRequestBaseBranch } from "./PullRequestBaseBranch";
import {
  PullRequestCheckoutMenuItems,
  PullRequestResolveConflictsButton,
  PullRequestPrimaryAction,
  PullRequestPrimaryActionMenu,
} from "./PullRequestDetailActions";
import { PullRequestActionsMenu } from "./PullRequestActionsMenu";
import { projectChangeRequestUrl } from "@t3tools/client-runtime/change-request-links";
import { normalizeThreadPullRequestKey } from "@t3tools/client-runtime/thread-pull-requests";
import { useLayoutPaneFocusedRef } from "../../layout/layoutPaneContext";
import { openPullRequestWorkspace } from "../../layout/openRules";
import { useAtomValue } from "@effect/atom-react";
import { usePullRequestStack } from "~/state/usePullRequestStack";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type PullRequestAction,
  type PullRequestDetail,
  type PullRequestMergeMethod,
  type PullRequestListEntry,
  type PullRequestUpdateMethod,
  type PullRequestRef,
  type PullRequestReviewGuideStop,
  resolveEnvironmentMachineKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ArrowDownUpIcon,
  ArrowLeftIcon,
  FileDiffIcon,
  GitCommitHorizontalIcon,
  PanelRightIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { type PullRequestDetailTab, useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import { resolveShortcutCommand, type ShortcutMatchContext } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { usePullRequestDefaultMergeMethodResolver } from "./usePullRequestActions";
import { offHeadPullRequestCheckoutToast } from "./pullRequestCheckoutToast";
import { usePreparePullRequestThreadAction } from "~/state/sourceControlActions";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { type ReviewCommentContext } from "~/reviewCommentContext";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { pullRequestEnvironment, usePullRequestTurnRefresh } from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestStackMenu } from "./PullRequestStackMenu";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import {
  capitalizeTerm,
  sourceControlClients,
} from "@t3tools/client-runtime/source-control-clients";
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";
import { vcsEnvironment } from "~/state/vcs";
import { RelativeTime } from "~/components/RelativeTime";
import { useUiStateStore } from "~/uiStateStore";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { TooltipProvider } from "../ui/tooltip";
import { PullRequestDetailGhost, PullRequestTimelineGhost } from "./PullRequestGhosts";
import { PullRequestCopyableCode } from "./PullRequestCopyableCode";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import { SourceControlAppAccessNotice } from "../SourceControlAppAccessNotice";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import { type PullRequestAgentSelectionInput } from "./PullRequestCodeTab";
import { openOnHostLabel } from "./pullRequestLinkContextMenu";
import { PullRequestMarkdownContext } from "./PullRequestMarkdown";
import { pullRequestAutolinkPlugins } from "./pullRequestMarkdown.logic";
import { PullRequestComposer } from "./PullRequestComposer";
import { PullRequestSummaryTab } from "./PullRequestSummaryTab";
import { PullRequestTimelineTab } from "./PullRequestTimelineTab";
import {
  buildAddSelectionToAgentHandoff,
  buildAskAboutGuideStopHandoff,
  buildAskAboutPullRequestHandoff,
  buildExplainPullRequestHandoff,
  buildFixFindingHandoff,
  buildFixFindingsHandoff,
  buildResolveConflictsPrompt,
  handoffPrompt,
  handoffReviewComments,
  latestPullRequestReviewOutcomes,
  loadingPullRequestCheckoutCommand,
  isPullRequestNotFound,
  isStackedPullRequestBase,
  pullRequestActionNeedsHostRefresh,
  pullRequestCheckoutCommand,
  pullRequestFindingKey,
  pullRequestHandoffLabels,
  PULL_REQUEST_MERGE_METHOD_LABELS,
  checkoutFailureDescription,
  readableFailure,
  resolvePullRequestReferenceHost,
  resolvePullRequestPrimaryControl,
  allowedPullRequestMergeMethods,
  allowsSinglePullRequestMerge,
  canDeletePullRequestBranch,
  isPullRequestConflicting,
  resolveBaseFreshness,
  resolvePullRequestMergeMethod,
  type PullRequestFinding,
  shouldRefreshPullRequestActivity,
  stripPullRequestHandoffReferences,
} from "./pullRequestDetail.logic";
import { resolvePickableEnvironments } from "./pullRequestProjectAssignment.logic";
import { PullRequestReadinessCard } from "./PullRequestReadinessCard";
import {
  PullRequestActorLabel,
  PullRequestMetaLine,
  PullRequestReviewOutcomeIcon,
  pullRequestChecksState,
  pullRequestChecksStatePresentation,
  pullRequestReviewOutcomeToneClassName,
  resolvePullRequestState,
  summarizePullRequestChecks,
} from "./pullRequestPresentation";
import { PullRequestGlyph } from "./pullRequestIcons";
import { PullRequestGuideTab } from "./PullRequestGuideTab";
import { guideRunKey, useGuideRunStore } from "./guide/guideRunStore";
import { useReviewGuideWriter } from "./guide/useReviewGuideWriter";
import { useInlineActionConfirm } from "./useInlineActionConfirm";

const actionFailureLabels = (term: string): Record<PullRequestAction, string> => ({
  merge: `Could not merge this ${term}`,
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: `Could not close this ${term}`,
  reopen: `Could not reopen this ${term}`,
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not turn on auto-merge",
  "disable-auto-merge": "Could not turn off auto-merge",
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
    "The host refused it. Check that you have write access to the branch (a fork branch also needs its author to allow edits from maintainers), and that it does not conflict with the base.",
  "enable-auto-merge":
    "The host refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.",
  "disable-auto-merge":
    "The host refused it. Check that you have write access, and that the merge has not already happened.",
  revert: `The host refused it. Check that you have write access and that this ${term} was merged on the host.`,
  "delete-branch":
    "The host refused it. Check that you have write access to the source repository and that the branch has not moved since this page loaded.",
  "approve-workflows":
    "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
});

const UPDATE_BRANCH_REBASE_FAILURE_HINT =
  "The host refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.";

const TABS: ReadonlyArray<{ value: PullRequestDetailTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "guide", label: "Guide" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

// Defer the diff viewer's worker pool until Code is approached.
const loadCodeTab = () => import("./PullRequestCodeTab");
const PullRequestCodeTab = lazy(loadCodeTab);

// Persist handoffs across unmounts; replace only unchanged contributions to preserve user edits.
const lastHandoffPromptByDraft = new Map<string, string>();

const composerTargetKey = (target: ScopedThreadRef | DraftId): string =>
  typeof target === "string" ? target : scopedThreadKey(target);

function resolvePullRequestReference(
  requestedReference: PullRequestRef,
  repositoryIdentity: Parameters<typeof resolvePullRequestReferenceHost>[1],
  supportsThreadPullRequests: boolean,
): PullRequestRef {
  return supportsThreadPullRequests
    ? resolvePullRequestReferenceHost(requestedReference, repositoryIdentity)
    : {
        projectId: requestedReference.projectId,
        repository: requestedReference.repository,
        number: requestedReference.number,
      };
}

function pullRequestMarkdownContext(
  detail: Pick<PullRequestDetail, "provider" | "url"> | null,
  threadRef: ScopedThreadRef | null,
) {
  return {
    remarkPlugins: pullRequestAutolinkPlugins(detail),
    lineBreaks: sourceControlClients.find(detail?.provider ?? "")?.hardLineBreaks ?? false,
    threadRef,
  };
}

function pullRequestStackReference(
  detail: Pick<PullRequestDetail, "url" | "capabilities"> | null,
  reference: PullRequestRef,
  supportsThreadPullRequests: boolean,
) {
  return detail === null || detail.capabilities.stacks !== true || !supportsThreadPullRequests
    ? null
    : {
        ...reference,
        host: reference.host ?? sourceControlClients.parseChangeRequestUrl(detail.url)?.link.host,
      };
}

export function PullRequestDetailPanel({
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
}: {
  environmentId: EnvironmentId;
  shortcutsEnabled: boolean;
  getShortcutContext: () => ShortcutMatchContext;
  onSelectPullRequest?: ((reference: PullRequestRef) => void) | undefined;
  threadRef?: ScopedThreadRef | null;
  reference: PullRequestRef;
  listEntry?: PullRequestListEntry | null;
  refreshToken?: number;
  /**
   * The pull requests page's panel: its tab lives in the guide run store, where a review guide
   * notification can switch it.
   */
  tabOnPage?: boolean;
  onActed?: (action?: PullRequestAction, phase?: "sent" | "done" | "failed") => void;
  onClose?: () => void;
  context?: "page" | "thread";
  composerDraftTarget?: ScopedThreadRef | DraftId;
  onBack?: (() => void) | undefined;
  onGuideShown?: (() => void) | undefined;
  initialTab?: PullRequestDetailTab;
  onTabChange?: ((tab: PullRequestDetailTab) => void) | undefined;
}) {
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
  const [codeToolbarContainer, setCodeToolbarContainer] = useState<HTMLDivElement | null>(null);
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
  const [titleScope, setTitleScope] = useState<{
    readonly pullRequestKey: string;
    readonly text: string;
  } | null>(null);
  const titleDraft = titleScope?.pullRequestKey === pullRequestKey ? titleScope.text : null;
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
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
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
  const paneFocusedRef = useLayoutPaneFocusedRef();
  const copyFromShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (!paneFocusedRef.current) return;
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

  // Checking the branch out, offered from the actions menu and the merge button's menu. Beside a
  // thread the branch is already under the reader's feet, so neither offers it there.
  const checkoutMenuItems = (
    <PullRequestCheckoutMenuItems
      handoff={handoff}
      checkoutRoot={checkoutRoot}
      canPrepareWorktree={canPrepareWorktree}
      canCheckoutHere={prepareThread.isAllowed}
      onCheckout={startCheckout}
    />
  );

  const resolveConflictsControl = (
    <PullRequestResolveConflictsButton
      handoff={handoff}
      unavailable={attachTarget === null && (checkoutRoot === null || !canPrepareWorktree)}
      onResolve={startResolveConflicts}
    />
  );

  const stackMenuProps =
    detail !== null && nativeStack
      ? {
          hostLabel: hostClient.label,
          terminology,
          stack: nativeStack,
          notice: nativeStackQuery.notice,
          syncedAt: nativeStackQuery.dataUpdatedAt,
          onRetry: nativeStackQuery.error ? nativeStackQuery.refresh : undefined,
          reference,
          environmentId,
          onSelect: onSelectPullRequest,
          mergeMethod: selectedMergeMethod,
          stale: !nativeStackQuery.isFresh,
          canMerge: supportsStackActions && can("merge") && allowedMergeMethods.length > 0,
          canRebase: supportsStackActions && detail.viewerPermissions.stackRebase === true,
          onActed: () => {
            refreshDetail();
            onActed?.();
          },
        }
      : null;

  const hasPrimaryButton =
    primaryAction === "resolve" ||
    primaryAction === "ready" ||
    primaryAction === "enable-auto-merge" ||
    primaryAction === "merge";
  const hasPrimaryControl = hasPrimaryButton || primaryAction === "auto-merge-armed";
  const primaryControl = hasPrimaryControl ? (
    <PullRequestPrimaryAction
      primaryAction={primaryAction}
      mergeBlockedReason={mergeBlockedReason}
      handoff={handoff}
      unavailable={attachTarget === null && (checkoutRoot === null || !canPrepareWorktree)}
      onResolve={startResolveConflicts}
      pendingAction={pendingAction}
      perform={perform}
      inlineConfirm={inlineConfirm}
      selectedMergeMethod={selectedMergeMethod}
      selectedMergeMethodLabel={selectedMergeMethodLabel}
      pendingAutoMergeLabel={pendingAutoMergeLabel}
      armedAutoMergeLabel={armedAutoMergeLabel}
    />
  ) : null;
  const stackMergeButton =
    stackMenuProps !== null && stackMenuProps.canMerge ? (
      <PullRequestStackMenu {...stackMenuProps} display="merge-button" />
    ) : null;
  const showsArmedNote = autoMergeArmed && primaryAction !== "auto-merge-armed";
  const noteStackMerge = hasPrimaryControl ? stackMergeButton : null;
  const updateMethods = freshness?.methods ?? [];
  const splitMenuHasItems =
    showsMergeMethods ||
    showsMergeNow ||
    showsAutoMerge ||
    updateMethods.length > 0 ||
    context === "page";
  const splitMenu =
    !hasPrimaryButton || !splitMenuHasItems || detail === null ? null : (
      <PullRequestPrimaryActionMenu
        showsMergeMethods={showsMergeMethods}
        showsMergeNow={showsMergeNow}
        showsAutoMerge={showsAutoMerge}
        autoMergeArmed={autoMergeArmed}
        allowedMergeMethods={allowedMergeMethods}
        selectedMergeMethod={selectedMergeMethod}
        onSelectMergeMethod={(method) => {
          setMergeMethod(method);
          setLastSelectedMergeMethod(method);
        }}
        pendingAction={pendingAction}
        perform={perform}
        inlineConfirm={inlineConfirm}
        can={can}
        updateMethods={updateMethods}
        showCheckout={context === "page"}
        checkoutMenuItems={checkoutMenuItems}
      />
    );
  const readinessCard =
    detail === null ? null : (
      <TooltipProvider delay={150} closeDelay={150} timeout={400}>
        <PullRequestReadinessCard
          environmentId={environmentId}
          threadRef={threadRef}
          reference={reference}
          detail={detail}
          activityPending={activityPending}
          checksState={checksState}
          checksStale={checksStale}
          checksSummary={checksSummary}
          canApproveWorkflows={showsApproveWorkflows}
          approvingWorkflows={pendingAction === "approve-workflows"}
          approveWorkflows={{
            armed: inlineConfirm.isArmed("approve-workflows"),
            ...inlineConfirm.props("approve-workflows", () => void perform("approve-workflows")),
          }}
          onRefreshChecks={() => void refreshFromHost()}
          pendingFinding={handoff}
          fixCheckLabel={handoffLabels.fixCheck}
          {...(canFixFindings ? { onFixFinding: startFixFinding } : {})}
          mergeMethodLabel={
            detail.state === "open" && allowedMergeMethods.length > 0 ? selectedMergeMethod : null
          }
          freshness={freshness}
          actionPending={actionPending}
          onUpdateBranch={(method) => void perform("update-branch", undefined, method)}
          resolveConflicts={primaryAction === "resolve" ? null : resolveConflictsControl}
          primary={primaryControl ?? stackMergeButton}
          primaryMenu={splitMenu}
          primaryMenuVariant={primaryAction === "resolve" ? "destructive-outline" : "default"}
          note={
            showsArmedNote || noteStackMerge !== null ? (
              <>
                {/* Said under the merge button, because it is the answer to why nobody has */}
                {showsArmedNote ? (
                  <p className="flex items-center gap-1.5 text-info-foreground">
                    <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                    {armedAutoMergeLabel} is on: the host merges this once its requirements are met
                  </p>
                ) : null}
                {noteStackMerge}
              </>
            ) : null
          }
        />
      </TooltipProvider>
    );

  if (detailQuery.isPending && !detail) {
    return (
      <PullRequestDetailGhost
        seed={matchingListEntry}
        summary={sharedSummary}
        number={reference.number}
        tabs={visibleTabs}
        activeTab={tab}
        {...(onBack ? { onBack } : {})}
        {...(onClose ? { onClose } : {})}
      />
    );
  }

  return (
    <div
      className="relative flex h-[calc(100%+var(--surface-top-inset,0px))] min-h-0 w-full flex-col bg-(--code-surface) pt-under-header"
      data-surface-reaches-under-header=""
    >
      {threadPickerOpen && detail ? (
        <PullRequestThreadLinks
          key={`${environmentId}:${detail.url}`}
          display="picker"
          environmentId={environmentId}
          reference={reference}
          url={detail.url}
          threadRef={null}
          onPickerOpenChange={setThreadPickerOpen}
        />
      ) : null}
      <div
        className={cn(
          "@container/pr-header grid min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2",
          detail && "border-b border-(--detail-separator)",
          !detail && !onClose && "hidden",
        )}
      >
        <PullRequestDetailCrumbs
          detail={detail}
          toneClassName={statePresentation?.toneClassName ?? null}
          openOnHostText={openOnHostText}
          onBack={onBack}
        >
          {detail ? (
            <>
              {stackMenuProps !== null ? (
                <PullRequestStackMenu {...stackMenuProps} display="trigger" />
              ) : supportsStackActions && nativeStackQuery.error ? (
                <Button variant="ghost" size="micro" onClick={nativeStackQuery.refresh}>
                  Retry stack lookup
                </Button>
              ) : null}
              <span className="ml-auto inline-flex shrink-0 items-baseline gap-1.5 text-caption text-muted-foreground">
                <span
                  className="inline-flex items-baseline gap-1 tabular-nums"
                  aria-label={`${detail.changedFiles.toLocaleString()} changed ${detail.changedFiles === 1 ? "file" : "files"}`}
                >
                  <FileDiffIcon aria-hidden className="size-3 self-center" />
                  {detail.changedFiles.toLocaleString()}
                </span>
                <PullRequestChangeBreakdownStat
                  environmentId={environmentId}
                  reference={reference}
                  additions={detail.additions}
                  deletions={detail.deletions}
                  className="shrink-0 font-mono text-caption"
                  eager
                />
              </span>
            </>
          ) : null}
        </PullRequestDetailCrumbs>
        <div className="mt-2 mr-3 flex h-6 shrink-0 select-none items-center justify-end gap-1">
          {detail && context === "page" ? (
            <TooltipProvider delay={150} closeDelay={150} timeout={400}>
              <PullRequestThreadLinks
                display="count"
                environmentId={environmentId}
                reference={reference}
                url={detail.url}
                threadRef={null}
              />
            </TooltipProvider>
          ) : null}
          {detail ? (
            <TooltipProvider delay={150} closeDelay={150} timeout={400}>
              <PullRequestActionsMenu
                environmentId={environmentId}
                reference={reference}
                pullRequestKey={pullRequestKey}
                detail={detail}
                terminology={terminology}
                linkThreadRef={
                  threadRef ??
                  (typeof composerDraftTarget === "object" ? composerDraftTarget : null)
                }
                onOpenAsWorkspace={
                  threadRef !== null && context !== "page"
                    ? () => openPullRequestWorkspace(threadRef, reference.number)
                    : undefined
                }
                onThreadPickerOpenChange={setThreadPickerOpen}
                refreshing={refreshing}
                refreshFromHost={refreshFromHost}
                handoff={handoff}
                attachesToComposer={attachTarget !== null}
                askAboutPullRequest={askAboutPullRequest}
                explainPullRequest={explainPullRequest}
                canFixFindings={canFixFindings}
                startFixFindings={startFixFindings}
                handoffLabels={handoffLabels}
                canWriteGuide={reviewGuidesEnabled && guideWriter.canWrite}
                guideRunning={guideWriter.running}
                guideWritten={guideWriter.data?.guide != null}
                writeGuide={writeGuide}
                pickableEnvironments={pickableEnvironments}
                actingEnvironmentId={actingEnvironmentId}
                onActingEnvironmentChange={(next) =>
                  setActingScope({ pullRequestKey, environmentId: next })
                }
                can={can}
                autoMergeArmed={autoMergeArmed}
                showsDraftToggle={showsDraftToggle}
                showsMergeNow={showsMergeNow}
                showsAutoMerge={showsAutoMerge}
                showsMergeMethods={showsMergeMethods}
                allowedMergeMethods={allowedMergeMethods}
                selectedMergeMethod={selectedMergeMethod}
                onSelectMergeMethod={(method) => {
                  setMergeMethod(method);
                  setLastSelectedMergeMethod(method);
                }}
                showsDeleteBranch={showsDeleteBranch}
                environmentConnected={environmentConnected}
                canWriteSourceControl={canWriteSourceControl}
                onMaintainerEditsSaved={refreshDetail}
                confirmDeleteBranch={confirmDeleteBranch}
                pendingAction={pendingAction}
                perform={perform}
                openOnHostText={openOnHostText}
                copyReference={copyReference}
                inlineConfirm={inlineConfirm}
                showCheckout={context === "page"}
                checkoutMenuItems={checkoutMenuItems}
                onEditTitle={() => setTitleScope({ pullRequestKey, text: detail.title })}
                repositoryUrl={repositoryUrl}
                checkoutCommand={checkoutCommand}
              />
            </TooltipProvider>
          ) : null}
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Collapse ${terminology.singular} panel`}
              onClick={onClose}
            >
              <PanelRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        {detail ? (
          <div className="col-span-2 flex min-w-0 flex-col gap-1.5 px-4 pt-1.5 pb-2.5">
            <PullRequestTitleEditor
              environmentId={environmentId}
              reference={reference}
              detail={detail}
              canWriteSourceControl={canWriteSourceControl}
              value={titleDraft}
              onValueChange={(text) =>
                setTitleScope(text === null ? null : { pullRequestKey, text })
              }
              onSaved={refreshDetail}
            />
            <div className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-meta text-muted-foreground">
              <PullRequestActorLabel actor={detail.author} profileUrl={authorProfileUrl} />
              <span className="shrink-0">
                <RelativeTime timestamp={detail.updatedAt} />
              </span>
              <span className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5 font-mono text-caption text-dim-foreground">
                <PullRequestBaseBranch
                  compact
                  baseBranch={detail.baseBranch}
                  freshness={freshness}
                  stacked={isStackedPullRequest}
                  pending={actionPending}
                  onUpdate={(method) => void perform("update-branch", undefined, method)}
                  iconClassName="size-3"
                />
                <ArrowLeftIcon aria-label="receives changes from" className="size-3 shrink-0" />
                <PullRequestCopyableCode
                  key={detail.headBranch}
                  className="min-w-12 rounded-kbd bg-secondary px-1.5 py-px text-muted-foreground"
                  value={detail.headBranch}
                  target="branch name"
                  copyLabel={`Copy ${terminology.singular} branch`}
                  copiedLabel="Branch name copied"
                />
              </span>
            </div>
          </div>
        ) : null}

        {detail ? (
          <nav
            className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-1.5 pb-3"
            aria-label={`${capitalizeTerm(terminology.singular)} tabs`}
          >
            <ToggleGroup
              className="w-full"
              size="segmented-wide"
              variant="segmented"
              value={[tab]}
              onValueChange={(next) => {
                const nextTab = visibleTabs.find((item) => item.value === next[0])?.value;
                if (nextTab) selectTab(nextTab);
              }}
            >
              {visibleTabs.map((item) => (
                <Toggle
                  key={item.value}
                  value={item.value}
                  className="flex-1"
                  onPointerEnter={item.value === "code" ? () => void loadCodeTab() : undefined}
                  onFocus={item.value === "code" ? () => void loadCodeTab() : undefined}
                >
                  {item.label}
                </Toggle>
              ))}
            </ToggleGroup>
            <div
              ref={setCodeToolbarContainer}
              className={cn("min-w-56 flex-1", tab === "code" ? "flex" : "hidden")}
            />
            {tab === "timeline" ? (
              <div className="ml-auto flex shrink-0 items-center gap-2 text-meta text-muted-foreground">
                <PullRequestMetaLine
                  className={cn(
                    "whitespace-nowrap text-caption transition-opacity",
                    (activityPending || activityError) && "opacity-35",
                  )}
                >
                  <span
                    className="inline-flex items-center gap-1"
                    aria-label={
                      activityError
                        ? "Commits unavailable"
                        : `${detail.commits.length.toLocaleString()} ${
                            detail.commits.length === 1 ? "commit" : "commits"
                          }`
                    }
                  >
                    <GitCommitHorizontalIcon aria-hidden className="size-3" />
                    {activityError
                      ? "-"
                      : activityPending
                        ? "…"
                        : detail.commits.length.toLocaleString()}
                  </span>
                  {approvalCount > 0 ? (
                    <span
                      className={cn(
                        "inline-flex items-center gap-1",
                        pullRequestReviewOutcomeToneClassName("approved"),
                      )}
                    >
                      <PullRequestReviewOutcomeIcon outcome="approved" className="size-3" />
                      {approvalCount.toLocaleString()}
                      <span className="sr-only">
                        {approvalCount === 1 ? "approval" : "approvals"}
                      </span>
                    </span>
                  ) : null}
                </PullRequestMetaLine>
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-label={
                    timelineOrder === "newest"
                      ? "Show oldest activity first"
                      : "Show newest activity first"
                  }
                  onClick={() =>
                    setTimelineOrder((value) => (value === "newest" ? "oldest" : "newest"))
                  }
                >
                  <ArrowDownUpIcon aria-hidden className="size-3" />
                  {timelineOrder === "newest" ? "Newest first" : "Oldest first"}
                </Button>
              </div>
            ) : null}
          </nav>
        ) : null}
      </div>

      <SourceControlAppAccessNotice
        environmentId={environmentId}
        provider={detail?.provider ?? repositoryIdentity?.provider}
        host={reference.host}
        repository={reference.repository}
        className="border-b border-(--detail-separator)"
      />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {detailQuery.error && !detail ? (
          <PullRequestsUnavailableState
            {...(isPullRequestNotFound(detailQuery.failure)
              ? {
                  title: `${capitalizeTerm(terminology.singular)} #${reference.number} not found`,
                  error: `It may be an issue rather than a ${terminology.singular}, or this account can't see it.`,
                }
              : { error: detailQuery.error })}
            refreshing={detailQuery.isPending}
            onRetry={refreshDetail}
            {...(unavailableHostUrl
              ? {
                  host: {
                    url: unavailableHostUrl,
                    openLabel: openOnHostLabel(
                      sourceControlClients.get(repositoryIdentity?.provider),
                    ),
                  },
                }
              : {})}
          />
        ) : detail ? (
          <PullRequestMarkdownContext value={markdownContext}>
            {mountedTabs.has("summary") ? (
              <div className={cn("absolute inset-0", tab !== "summary" && "invisible")}>
                <PullRequestSummaryTab
                  readiness={readinessCard}
                  environmentId={environmentId}
                  threadRef={threadRef}
                  reference={reference}
                  detail={detail}
                  activityPending={activityPending}
                  activityError={activityError}
                  pendingFinding={handoff}
                  fixFindingLabel={handoffLabels.fixFinding}
                  {...(canFixFindings ? { onFixFinding: startFixFinding } : {})}
                  onRefresh={refreshDetail}
                />
              </div>
            ) : null}
            {mountedTabs.has("guide") ? (
              <div
                className={cn("absolute inset-0", tab !== "guide" && "invisible")}
                // Read by the guide run notifier, which stays quiet for a guide on screen.
                data-guide-shown={tab === "guide" ? guideKey : undefined}
              >
                <PullRequestGuideTab
                  environmentId={environmentId}
                  reference={reference}
                  active={tab === "guide"}
                  title={detail.title}
                  workspaceRoot={detail.workspaceRoot}
                  canComment={
                    detail.capabilities.review.inlineComment && detail.viewerPermissions.comment
                  }
                  rangeComments={detail.capabilities.review.rangeComment === true}
                  onAskAboutLines={(comment, request) =>
                    addSelectionToAgent({ comment, request }, { keepGuide: true })
                  }
                  onAskAboutStop={askAboutGuideStop}
                  onFinishReview={
                    detail.capabilities.review.verdicts.some((verdict) =>
                      detail.viewerPermissions.verdicts.includes(verdict),
                    )
                      ? () => setOpenReviewRequest((count) => count + 1)
                      : null
                  }
                  onOpenFile={openFileInCode}
                  onTourShown={onGuideShown}
                />
              </div>
            ) : null}
            {mountedTabs.has("timeline") ? (
              <div className={cn("absolute inset-0", tab !== "timeline" && "invisible")}>
                {activityPending ? (
                  <PullRequestTimelineGhost />
                ) : activityError ? (
                  <PullRequestActivityUnavailableState
                    error={activityError}
                    term={terminology.singular}
                    onRetry={activityQuery.refresh}
                  />
                ) : (
                  <PullRequestTimelineTab
                    detail={detail}
                    environmentId={environmentId}
                    threadRef={threadRef}
                    order={timelineOrder}
                    onOpenCommit={openCommit}
                    onOpenCode={openFileInCode}
                  />
                )}
              </div>
            ) : null}
            {mountedTabs.has("code") ? (
              <div className={cn("absolute inset-0", tab !== "code" && "invisible")}>
                <Suspense
                  fallback={
                    <DiffPanelLoadingState label={`Loading ${terminology.singular} diff...`} />
                  }
                >
                  <PullRequestCodeTab
                    toolbarContainer={codeToolbarContainer}
                    onAddToAgentSelection={addSelectionToAgent}
                    environmentId={environmentId}
                    reference={reference}
                    detail={detail}
                    selectedCommitOid={selectedCodeCommitOid}
                    onSelectedCommitChange={selectCodeCommit}
                    pendingFinding={handoff}
                    fixFindingLabel={handoffLabels.fixFinding}
                    {...(canFixFindings ? { onFixFinding: startFixFinding } : {})}
                    onRefresh={refreshDetail}
                    refreshToken={refreshToken}
                    backgroundRefreshToken={turnRefresh ?? 0}
                    revealRequest={codeRevealRequest}
                  />
                </Suspense>
              </div>
            ) : null}
          </PullRequestMarkdownContext>
        ) : null}
      </div>

      {/* Float over the content; do not reserve a footer or padding in the PR tabs. Inset 16 on
          both sides: the content's right line and its bottom padding. */}
      {detail ? (
        <div className="absolute right-4 bottom-4 z-20">
          <PullRequestComposer
            key={JSON.stringify([
              environmentId,
              reference.projectId,
              reference.host,
              reference.repository,
              reference.number,
            ])}
            environmentId={environmentId}
            reference={reference}
            detail={detail}
            actionPending={actionPending}
            onCommentAction={performCommentAction}
            onCommented={refreshDetail}
            onReviewSubmitted={refreshDetail}
            openReviewRequest={openReviewRequest}
          />
        </div>
      ) : null}
    </div>
  );
}
