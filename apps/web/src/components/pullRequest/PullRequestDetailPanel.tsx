import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { useAtomValue } from "@effect/atom-react";
import { usePullRequestStack } from "~/state/usePullRequestStack";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { AnimatedWidth } from "~/components/AnimatedWidth";
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
  ArrowUpRightIcon,
  BookOpenIcon,
  CheckIcon,
  CircleDotIcon,
  CopyIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  HammerIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  LinkIcon,
  MoreHorizontalIcon,
  PanelRightIcon,
  PlayIcon,
  RotateCcwIcon,
  SparklesIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  lazy,
  Suspense,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { type PullRequestDetailTab, useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { isCommandPaletteOpen } from "~/commandPaletteBus";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  type ShortcutMatchContext,
} from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { usePullRequestDefaultMergeMethodResolver } from "./usePullRequestActions";
import { OFF_HEAD_PULL_REQUEST_CHECKOUT_TOAST } from "./pullRequestCheckoutToast";
import { changeRequestRepositoryUrl, gitHubPullRequestBrowserUrl } from "~/lib/openPullRequestLink";
import { usePreparePullRequestThreadAction } from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import type { ReviewCommentContext } from "~/reviewCommentContext";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import {
  pullRequestEnvironment,
  pullRequestListEntryToSummary,
  newestPullRequestSummary,
  usePullRequestTurnRefresh,
  useSharedPullRequestSummary,
} from "~/state/pullRequests";
import { useAtomCommand } from "~/state/use-atom-command";
import { PullRequestStackMenu } from "./PullRequestStackMenu";
import { PullRequestChangeBreakdownStat } from "./PullRequestChangeBreakdownStat";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { PullRequestThreadLinks } from "./PullRequestThreadLinks";
import { vcsEnvironment } from "~/state/vcs";
import { RelativeTime } from "~/components/RelativeTime";
import { useUiStateStore } from "~/uiStateStore";

import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { PullRequestEditButton } from "./PullRequestEditButton";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import {
  PullRequestChecksStatusLine,
  PullRequestDetailHeaderBody,
  PullRequestDetailTabBar,
  PullRequestDetailTitleRow,
} from "./PullRequestDetailLayout";
import { PullRequestDetailGhost, PullRequestTimelineGhost } from "./PullRequestGhosts";
import { PullRequestCopyableCode } from "./PullRequestCopyableCode";
import { PullRequestActivityUnavailableState } from "./PullRequestActivityUnavailableState";
import { DiffPanelLoadingState } from "../DiffPanelShell";
import { PullRequestsUnavailableState } from "./PullRequestsUnavailableState";
import type { PullRequestAgentSelectionInput } from "./PullRequestCodeTab";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import { PullRequestMarkdownContext } from "./PullRequestMarkdown";
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
  pullRequestActionMenuHasGroup,
  pullRequestActionNeedsHostRefresh,
  pullRequestCheckoutCommand,
  pullRequestFindingKey,
  pullRequestHandoffLabels,
  PULL_REQUEST_MERGE_METHOD_LABELS,
  checkoutFailureDescription,
  readableFailure,
  readPullRequestDetailSnapshot,
  resolvePullRequestReferenceHost,
  resolveDisplayedPullRequestDetail,
  resolvePullRequestPrimaryControl,
  allowsSinglePullRequestMerge,
  canDeletePullRequestBranch,
  resolveBaseFreshness,
  resolvePullRequestMergeMethod,
  type PullRequestFinding,
  shouldRefreshPullRequestActivity,
  stripPullRequestHandoffReferences,
  writePullRequestDetailSnapshot,
} from "./pullRequestDetail.logic";
import { canEditPullRequestChangeRequest } from "./pullRequestEditing.logic";
import {
  resolvePickableEnvironments,
  type PickableEnvironment,
} from "./pullRequestProjectAssignment.logic";
import { PullRequestChecksPopover } from "./PullRequestChecksPopover";
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

const ACTION_FAILURE_LABELS: Record<PullRequestAction, string> = {
  merge: "Could not merge this pull request",
  ready: "Could not mark this ready for review",
  draft: "Could not convert this to a draft",
  close: "Could not close this pull request",
  reopen: "Could not reopen this pull request",
  "update-branch": "Could not update this branch",
  "enable-auto-merge": "Could not turn on auto-merge",
  "disable-auto-merge": "Could not turn off auto-merge",
  revert: "Could not open a revert pull request",
  "delete-branch": "Could not delete this branch",
  "approve-workflows": "Could not approve workflows",
};

const ACTION_FAILURE_HINTS: Record<PullRequestAction, string> = {
  merge:
    "The host refused the merge. Check that you have write access, that the checks it requires have passed, and that the branch is not conflicting.",
  ready: "The host refused it. Check that you have write access to this repository.",
  draft: "The host refused it. Check that you have write access to this repository.",
  close: "The host refused it. Check that you have write access, or that you opened it.",
  reopen:
    "The host refused it. Check that you have write access, and that the branch still exists.",
  "update-branch":
    "The host refused it. Check that you have write access to the branch — one from a fork also needs its author to allow edits from maintainers — and that it does not conflict with the base.",
  "enable-auto-merge":
    "The host refused it. Check that this repository allows auto-merge, that you have write access, and that there is something left for it to wait on.",
  "disable-auto-merge":
    "The host refused it. Check that you have write access, and that the merge has not already happened.",
  revert:
    "The host refused it. Check that you have write access and that this pull request was merged on the host.",
  "delete-branch":
    "The host refused it. Check that you have write access to the source repository and that the branch has not moved since this page loaded.",
  "approve-workflows":
    "The host refused it. Check that you have Actions write access and that these workflow runs are still awaiting approval.",
};

const UPDATE_BRANCH_REBASE_FAILURE_HINT =
  "The host refused it. A rebase stops at the first commit that does not apply cleanly; updating with a merge commit may still work.";

const TABS: ReadonlyArray<{ value: PullRequestDetailTab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "guide", label: "Guide" },
  { value: "timeline", label: "Timeline" },
  { value: "code", label: "Code" },
];

// The diff viewer pulls in its worker pool, so load it only when the reader approaches Code.
const loadCodeTab = () => import("./PullRequestCodeTab");
const PullRequestCodeTab = lazy(loadCodeTab);

/**
 * What the last hand-off wrote into each draft, kept outside React because the panel that wrote it
 * is closed by the time the next one opens. It is how a prompt the reader has since edited is told
 * apart from the one they were handed: only the sentence still exactly as written may be replaced.
 */
const lastHandoffPromptByDraft = new Map<string, string>();

const composerTargetKey = (target: ScopedThreadRef | DraftId): string =>
  typeof target === "string" ? target : scopedThreadKey(target);

function ActOnEnvironmentPicker({
  environments,
  value,
  onChange,
  disabled,
}: {
  environments: ReadonlyArray<PickableEnvironment>;
  value: EnvironmentId;
  onChange: (environmentId: EnvironmentId) => void;
  disabled: boolean;
}) {
  return (
    <>
      <MenuSeparator />
      <MenuRadioGroup
        value={value}
        onValueChange={(environmentId) => onChange(environmentId as EnvironmentId)}
      >
        {environments.map((environment) => (
          <MenuRadioItem
            key={environment.environmentId}
            value={environment.environmentId}
            disabled={disabled}
          >
            <span className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon
                kind={environment.machine ?? "server"}
                className="size-3.5 shrink-0"
              />
              <span className="truncate">{environment.label}</span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}

const openNumberContextMenu = (
  event: ReactMouseEvent,
  detail: { readonly url: string; readonly provider: string },
): void => {
  event.preventDefault();
  event.stopPropagation();
  void showPullRequestLinkContextMenu({
    url: detail.url,
    openLabel: openOnHostLabel(sourceControlClients.get(detail.provider)),
    position: { x: event.clientX, y: event.clientY },
  });
};

function PullRequestBaseFreshnessWarning({
  baseBranch,
  freshness,
  pending,
  onUpdate,
  iconClassName,
  className,
  children,
}: {
  readonly baseBranch: string;
  readonly freshness: {
    readonly behindBy: number | null;
    readonly methods: ReadonlyArray<PullRequestUpdateMethod>;
  };
  readonly pending: boolean;
  readonly onUpdate: (method: PullRequestUpdateMethod) => void;
  readonly iconClassName?: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  const behind =
    freshness.behindBy === null
      ? ""
      : ` by ${freshness.behindBy.toLocaleString()} ${
          freshness.behindBy === 1 ? "commit" : "commits"
        }`;
  const summary = `This branch is out-of-date with ${baseBranch}${behind}.`;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={0}
        closeDelay={120}
        render={
          <button
            type="button"
            aria-label={summary}
            className={cn(
              "inline-flex min-w-0 shrink-0 cursor-help items-center gap-1 rounded-sm text-warning-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              className,
            )}
          />
        }
      >
        {children}
        <TriangleAlertIcon aria-hidden className={cn("size-3.5 shrink-0", iconClassName)} />
      </PopoverTrigger>
      <PopoverPopup align="start" side="bottom" className="max-w-80" padding="compact">
        <p className="text-xs text-foreground">{summary}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Changes can be cleanly merged.</p>
        {freshness.methods.length > 0 ? (
          <span className="mt-2 flex flex-wrap items-center gap-1.5">
            {freshness.methods.map((method) => (
              <Button
                key={method}
                size="xs"
                variant="outline"
                disabled={pending}
                onClick={() => onUpdate(method)}
              >
                <PullRequestGlyph.merged aria-hidden className="size-3" />
                {method === "rebase" ? "Update with rebase" : "Update branch"}
              </Button>
            ))}
          </span>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function reportCheckoutCommandError(error: Error) {
  toastManager.add({
    type: "error",
    title: "Could not copy checkout command",
    description: error.message,
  });
}

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

function pullRequestRefKey(reference: PullRequestRef) {
  return `${reference.projectId}:${reference.host ?? ""}:${reference.repository}#${reference.number}`;
}

function pullRequestDetailSummary(data: PullRequestDetail | null) {
  return data === null ? null : { ...data, checksState: pullRequestChecksState(data.checks) };
}

/**
 * Loads a pull request's detail and activity and merges them, with the snapshot cache, the shared
 * summary and the list row, into the detail the panel shows.
 */
function usePullRequestDetail(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  listEntry: PullRequestListEntry | null,
) {
  const scopeKey = `${environmentId}:${pullRequestRefKey(reference)}`;
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  const activityQuery = useEnvironmentQuery(
    pullRequestEnvironment.activity({ environmentId, input: reference }),
  );
  const [cachedDetail, setCachedDetail] = useState(() =>
    readPullRequestDetailSnapshot(
      typeof window === "undefined" ? undefined : window.localStorage,
      environmentId,
      reference,
    ),
  );
  const [cachedDetailKey, setCachedDetailKey] = useState(scopeKey);
  if (cachedDetailKey !== scopeKey) {
    setCachedDetailKey(scopeKey);
    setCachedDetail(
      detailQuery.data ??
        readPullRequestDetailSnapshot(
          typeof window === "undefined" ? undefined : window.localStorage,
          environmentId,
          reference,
        ),
    );
  } else if (detailQuery.data !== null && detailQuery.data !== cachedDetail) {
    setCachedDetail(detailQuery.data);
  }
  const saveDetailSnapshot = useEffectEvent((data: PullRequestDetail) => {
    writePullRequestDetailSnapshot(
      typeof window === "undefined" ? undefined : window.localStorage,
      environmentId,
      reference,
      data,
    );
  });
  useEffect(() => {
    if (detailQuery.data !== null) saveDetailSnapshot(detailQuery.data);
  }, [detailQuery.data]);
  const detailSummary = pullRequestDetailSummary(detailQuery.data);
  const observedSummary = useSharedPullRequestSummary(
    environmentId,
    reference,
    detailSummary,
    detailQuery.dataUpdatedAt,
  );
  const activity = activityQuery.data;
  const resolvedCoreDetail = resolveDisplayedPullRequestDetail({
    live: detailQuery.data,
    cached: cachedDetail,
    reference,
  });
  // Every hook runs above this line: a hook between the merge and the panel's plain readers of
  // `detail` would cost it its cache scope.
  const listSummary = listEntry === null ? null : pullRequestListEntryToSummary(listEntry);
  // The list row is also published to the shared cache, but only after this commit's layout
  // effects run, so it is compared directly rather than trusted to be there already.
  const sharedSummary = newestPullRequestSummary(
    resolvedCoreDetail,
    newestPullRequestSummary(observedSummary, listSummary),
  );
  const coreDetail =
    resolvedCoreDetail === null || sharedSummary === null || sharedSummary === resolvedCoreDetail
      ? resolvedCoreDetail
      : {
          ...resolvedCoreDetail,
          title: sharedSummary.title,
          state: sharedSummary.state,
          headBranch: sharedSummary.headBranch,
          baseBranch: sharedSummary.baseBranch,
          updatedAt: sharedSummary.updatedAt,
          author: sharedSummary.author ?? resolvedCoreDetail.author,
          additions: sharedSummary.additions ?? resolvedCoreDetail.additions,
          deletions: sharedSummary.deletions ?? resolvedCoreDetail.deletions,
          changedFiles: sharedSummary.changedFiles ?? resolvedCoreDetail.changedFiles,
          mergeability: sharedSummary.mergeability ?? resolvedCoreDetail.mergeability,
          closedAt:
            sharedSummary.closedAt === undefined
              ? resolvedCoreDetail.closedAt
              : sharedSummary.closedAt,
          mergedAt:
            sharedSummary.mergedAt === undefined
              ? resolvedCoreDetail.mergedAt
              : sharedSummary.mergedAt,
          isDraft: sharedSummary.isDraft ?? resolvedCoreDetail.isDraft,
        };
  const detail =
    coreDetail === null
      ? null
      : {
          ...coreDetail,
          capabilities: canWriteSourceControl
            ? coreDetail.capabilities
            : {
                ...coreDetail.capabilities,
                reactions: false,
                edit: { changeRequest: false, comment: false },
              },
          viewerPermissions: canWriteSourceControl
            ? coreDetail.viewerPermissions
            : {
                ...coreDetail.viewerPermissions,
                actions: [],
                comment: false,
                resolve: false,
                verdicts: [],
                requestReviewers: false,
                updateMethods: [],
                labels: false,
              },
          author: activity?.author ?? coreDetail.author,
          reviewers: activity?.reviewers ?? coreDetail.reviewers,
          comments: activity?.comments ?? [],
          commentCount: Math.max(
            activity?.commentCount ?? 0,
            new Set([
              ...(activity?.comments.map((comment) => comment.id) ?? []),
              ...(activity?.reviewThreads.flatMap((thread) =>
                thread.comments.map((comment) => comment.id),
              ) ?? []),
            ]).size,
          ),
          commentsTruncated: activity?.commentsTruncated ?? false,
          reviewThreads: activity?.reviewThreads ?? [],
          commits: activity?.commits ?? [],
          reactions: activity?.reactions ?? [],
        };
  return {
    canWriteSourceControl,
    detailQuery,
    activityQuery,
    activity,
    sharedSummary,
    coreDetail,
    detail,
  };
}

function pullRequestMarkdownContext(
  hostClient: ReturnType<typeof sourceControlClients.get>,
  repositoryUrl: string | null,
  threadRef: ScopedThreadRef | null,
) {
  return {
    repositoryUrl:
      repositoryUrl === null ? null : hostClient.referenceAutolinkRepositoryUrl(repositoryUrl),
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
    : { ...reference, host: reference.host ?? parseChangeRequestUrl(detail.url)?.host };
}

export function PullRequestDetailPanel({
  environmentId,
  shortcutsEnabled,
  getShortcutContext,
  threadRef = null,
  reference: requestedReference,
  listEntry = null,
  refreshToken: forcedRefreshToken = 0,
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
  const supportsThreadPullRequests =
    environmentConfigs.get(environmentId)?.environment.capabilities.threadPullRequests === true;
  const reference = resolvePullRequestReference(
    requestedReference,
    repositoryIdentity,
    supportsThreadPullRequests,
  );
  const loadingCheckoutCommand = loadingPullRequestCheckoutCommand(reference, repositoryIdentity);
  const unavailableGitHubUrl = gitHubPullRequestBrowserUrl(
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
  const [threadPickerOpen, setThreadPickerOpen] = useState(false);
  const [openReviewRequest, setOpenReviewRequest] = useState(0);
  const [tab, setTab] = useState<PullRequestDetailTab>(initialTab);
  const selectTab = (next: PullRequestDetailTab) => {
    setTab(next);
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
  const guideOpenRequested = useGuideRunStore(
    (state) => state.openRequestKey === guideRunKey(environmentId, reference),
  );
  if (guideOpenRequested && tab !== "guide") setTab("guide");
  useEffect(() => {
    if (!guideOpenRequested) return;
    useGuideRunStore.getState().requestOpen(null);
    onTabChange?.("guide");
  }, [guideOpenRequested, onTabChange]);
  const tabScopeKey = `${environmentId}:${pullRequestKey}`;
  const [tabMountState, setTabMountState] = useState(() => ({
    key: tabScopeKey,
    tabs: new Set<PullRequestDetailTab>([tab]),
  }));
  // A previously visited Code tab must not fetch diffs for every later PR while hidden.
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
  const scrollerByTab = useRef<Partial<Record<PullRequestDetailTab, HTMLDivElement | null>>>({});
  // Fresh ref callbacks would detach and reattach every scroller on each render.
  const [scrollerRefs] = useState(() => ({
    summary: (node: HTMLDivElement | null) => {
      scrollerByTab.current.summary = node;
    },
    timeline: (node: HTMLDivElement | null) => {
      scrollerByTab.current.timeline = node;
    },
    code: (node: HTMLDivElement | null) => {
      scrollerByTab.current.code = node;
    },
  }));
  const foldRef = useRef<HTMLDivElement | null>(null);
  const condensedRowRef = useRef<HTMLDivElement | null>(null);
  // Save the target before collapse: the browser may clamp scrollTop as the viewport grows,
  // so applying a delta afterward would compensate twice.
  const compensationRef = useRef<{
    tab: PullRequestDetailTab;
    scroller: HTMLDivElement;
    target: number;
  } | null>(null);
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
  const inlineConfirm = useInlineActionConfirm(pullRequestKey);
  const [handoff, setHandoff] = useState<string | null>(null);
  const turnRefresh = usePullRequestTurnRefresh(environmentId);
  const {
    canWriteSourceControl,
    detailQuery,
    activityQuery,
    activity,
    sharedSummary,
    coreDetail,
    detail,
  } = usePullRequestDetail(environmentId, reference, matchingListEntry);
  const handoffSummary = detail ?? sharedSummary;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { copyToClipboard: copyReference } = useCopyToClipboard<string>({
    target: "pull request reference",
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
    if (!event.repeat) copyReference(`#${reference.number}`, "PR number");
  });
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
  const repositoryUrl = detail === null ? null : changeRequestRepositoryUrl(detail.url);
  const hostClient = sourceControlClients.get(detail?.provider);
  const openOnHostText = openOnHostLabel(hostClient);
  const markdownContext = pullRequestMarkdownContext(hostClient, repositoryUrl, threadRef);
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
        changeRequestRepositoryUrl(handoffSummary.url),
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
    detail.capabilities.stackActions === true &&
    environmentConfigs.get(environmentId)?.environment.capabilities.pullRequestStackActions ===
      true;
  const canMergeSinglePullRequest = allowsSinglePullRequestMerge({
    supportsStackActions,
    hasStack: nativeStack !== null,
    stackPending: !nativeStackQuery.isFresh,
    stackError: nativeStackQuery.error,
  });
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
      // Let an existing read settle before revalidating the new revision. Interrupting a
      // mutation's activity refresh can leave SWR displaying its previous value.
      setActivityRevision(next);
      setActivityRevalidations((count) => count + 1);
      setRefreshToken((token) => token + 1);
    }
  }
  const revalidateActivity = useEffectEvent(() => activityQuery.refresh());
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
    // Atom commands settle instead of throwing, so the reset below always runs.
    await invalidate({ environmentId, input: { reference } });
    refreshDetail();
    setRefreshToken((token) => token + 1);
    setIsInvalidating(false);
  };
  const refreshFromHostOnRequest = useEffectEvent(() => void refreshFromHost());
  const appliedForcedToken = useRef(forcedRefreshToken);
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
  const update = useAtomCommand(pullRequestEnvironment.update, { reportFailure: false });
  const [titleScope, setTitleScope] = useState<{
    readonly pullRequestKey: string;
    readonly text: string;
  } | null>(null);
  const titleDraft = titleScope?.pullRequestKey === pullRequestKey ? titleScope.text : null;
  const [titleSaving, setTitleSaving] = useState(false);
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
      // A merge strategy a branch policy forbids is refused at completion and nowhere earlier —
      // Azure DevOps publishes no per-strategy availability to hide the control with — so
      // "action failed" would leave the reader pressing the same button again.
      const failure = squashAtomCommandFailure(result);
      const hint =
        updateMethod === "rebase"
          ? UPDATE_BRANCH_REBASE_FAILURE_HINT
          : ACTION_FAILURE_HINTS[action];
      toastManager.add({
        type: "error",
        title: ACTION_FAILURE_LABELS[action],
        description: readableFailure(failure, hint),
      });
      onActed?.(action, "failed");
      return false;
    }
    if (action === "revert") {
      toastManager.add({ type: "success", title: "Revert pull request opened" });
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
    // The comment is durable even if the state change was refused, so make it visible while the
    // shared action failure explains why the pull request stayed where it was.
    if (!actionSucceeded) refreshDetail();
    return { commentPosted: true };
  };

  const saveTitle = async (next: string) => {
    const title = next.trim();
    if (!canWriteSourceControl || detail === null || titleSaving) return;
    if (title.length === 0 || title === detail.title) {
      setTitleScope(null);
      return;
    }
    setTitleSaving(true);
    const result = await update({ environmentId, input: { ...reference, title } });
    setTitleSaving(false);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "The title could not be saved",
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused the new title.",
        ),
      });
      return;
    }
    setTitleScope(null);
    refreshDetail();
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
            ? "The question is in the composer — read it over, then send."
            : "The pull request is in the composer — type your question, then send.",
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
          });
        useGuideRunStore.getState().requestOpen(guideRunKey(environmentId, reference));
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
          ? "The question is in the composer — read it over, then send."
          : "The pull request is in the composer — type your question, then send.",
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
        description: "The task is in the composer — read it over, then send.",
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
      title: "Preparing the pull request checkout...",
    });
    const projectRef = scopeProjectRef(
      actingEnvironmentId,
      acting?.projectId ?? handoffSummary.projectId,
    );
    // The thread is opened before the checkout rather than after it, because the project's setup
    // script only runs for a checkout that knows which thread it is for — and a worktree with no
    // dependencies installed is not something anyone can test.
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
        title: "Could not prepare the pull request checkout",
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
      // The checkout is on disk; only the thread failed to move onto it. Writing the task now
      // would send the agent at whatever the thread was already open on — which is the one
      // outcome worth stopping for, since it reads as success and is not.
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
                  ? "This repository is on the pull request's branch, with a thread open on it."
                  : "The pull request is in its own worktree, with a thread open on it.",
            }
          : OFF_HEAD_PULL_REQUEST_CHECKOUT_TOAST,
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
            description: "The task is in the composer — read it over, then send.",
          }
        : OFF_HEAD_PULL_REQUEST_CHECKOUT_TOAST,
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

  const allowedMergeMethods = detail
    ? detail.capabilities.mergeMethods.filter((method) => detail.mergeCapabilities[method])
    : [];
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
  const conflicting = detail?.state === "open" && detail.mergeability === "conflicting";
  const autoMergeArmed = detail?.state === "open" && detail.autoMergeEnabled === true;
  const armedMergeMethod = detail?.autoMergeMethod;
  const armedAutoMergeLabel = armedMergeMethod
    ? `Auto-merge (${PULL_REQUEST_MERGE_METHOD_LABELS[armedMergeMethod].toLowerCase()})`
    : "Auto-merge";
  const workflowApprovalsRequired =
    detail?.state === "open" ? (detail.workflowApprovalsRequired ?? 0) : 0;
  const freshness = detail === null ? null : resolveBaseFreshness(detail);
  const reviewGuidesEnabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.reviewGuidesEnabled,
  );
  const visibleTabs = TABS.filter(
    (item) =>
      (item.value !== "code" || detail === null || detail.capabilities.diff) &&
      (item.value !== "guide" || reviewGuidesEnabled),
  );
  // Keep unavailable-tab fallbacks out of the saved selection.
  if (!visibleTabs.some((item) => item.value === tab)) setTab("summary");
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
        canMerge: canMergeSinglePullRequest && can("merge"),
        canMarkReady: can("ready"),
        canEnableAutoMerge: canMergeSinglePullRequest && can("enable-auto-merge"),
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
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                disabled={handoff !== null || checkoutRoot === null}
                render={
                  <Button
                    size="xs"
                    variant="outline"
                    aria-label={handoff?.startsWith("checkout") ? "Checking out..." : "Check out"}
                  >
                    <GitBranchIcon aria-hidden className="size-3.5" />
                    <span className="@max-[35rem]/pr-header:hidden">
                      {handoff?.startsWith("checkout") ? "Checking out..." : "Check out"}
                    </span>
                    <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  </Button>
                }
              />
            }
          />
          <TooltipPopup>Check out this pull request</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side="bottom">
          <MenuItem disabled={!canPrepareWorktree} onClick={() => startCheckout("worktree")}>
            <GitBranchIcon className="mt-1 size-3.5 shrink-0 self-start" />
            <span className="flex min-w-0 flex-col">
              <span>In a separate worktree</span>
              <span className="text-xs text-muted-foreground">
                Its own folder and thread. Nothing you have open moves.
              </span>
            </span>
          </MenuItem>
          <MenuItem disabled={!prepareThread.isAllowed} onClick={() => startCheckout("local")}>
            <FolderGit2Icon className="mt-1 size-3.5 shrink-0 self-start" />
            <span className="flex min-w-0 flex-col">
              <span>In this repository</span>
              <span className="text-xs text-muted-foreground">
                Switches the branch you are working in, like `gh pr checkout`.
              </span>
            </span>
          </MenuItem>
          {pickableEnvironments.length > 0 ? (
            <ActOnEnvironmentPicker
              environments={pickableEnvironments}
              value={actingEnvironmentId}
              onChange={(next) => setActingScope({ pullRequestKey, environmentId: next })}
              disabled={handoff !== null}
            />
          ) : null}
        </MenuPopup>
      </Menu>
    ) : null;

  const resolveConflictsControl = (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={handoff !== null || (attachTarget === null && checkoutRoot === null)}
              onClick={startResolveConflicts}
              aria-label={handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
            >
              <PullRequestGlyph.conflicting aria-hidden className="size-3.5" />
              <span className="@max-[30rem]/pr-header:hidden">
                {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
              </span>
            </Button>
          </span>
        }
      />
      <TooltipPopup side="top">
        {handoff === "conflicts" ? "Preparing..." : "Resolve conflicts"}
      </TooltipPopup>
    </Tooltip>
  );

  if (detailQuery.isPending && !detail) {
    return (
      <PullRequestDetailGhost
        seed={matchingListEntry}
        summary={sharedSummary}
        checkoutCommand={checkoutCommand}
        onCheckoutError={reportCheckoutCommandError}
        number={reference.number}
        tabs={visibleTabs}
        activeTab={tab}
        {...(onBack ? { onBack } : {})}
        {...(onClose ? { onClose } : {})}
        actions={
          handoffSummary ? (
            <TooltipProvider delay={150} closeDelay={150} timeout={400}>
              {handoffSummary.state === "open" && handoffSummary.mergeability === "conflicting"
                ? resolveConflictsControl
                : null}
              {checkoutControl}
            </TooltipProvider>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-background">
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
          detail && "border-b border-border/60",
          !detail && !onClose && "hidden",
        )}
      >
        <div className="pl-4 grid h-7 min-w-0 items-center overflow-hidden">
          <div
            aria-hidden={condensed}
            inert={condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs",
              condensed
                ? "pointer-events-none -translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50 duration-150",
            )}
          >
            {detail && statePresentation ? (
              <>
                {onBack ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost-muted"
                          onClick={onBack}
                          className="-ml-1.5"
                          aria-label="Back to this thread's pull requests"
                        >
                          <ArrowLeftIcon aria-hidden className="size-3.5" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Back to pull requests</TooltipPopup>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      repositoryUrl ? (
                        <button
                          type="button"
                          onClick={() => void readLocalApi()?.shell.openExternal(repositoryUrl)}
                          className="min-w-0 cursor-pointer truncate text-left font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                        >
                          {detail.repository}
                        </button>
                      ) : (
                        <span className="min-w-0 truncate font-medium text-muted-foreground">
                          {detail.repository}
                        </span>
                      )
                    }
                  />
                  <TooltipPopup side="top">
                    {repositoryUrl ? `Open ${detail.repository} repository` : detail.repository}
                  </TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
                        onAuxClick={(event) => {
                          if (event.button === 1)
                            void readLocalApi()?.shell.openExternal(detail.url);
                        }}
                        onContextMenu={(event) => openNumberContextMenu(event, detail)}
                        className={cn(
                          "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline",
                          statePresentation.toneClassName,
                        )}
                        aria-label={`Open pull request #${detail.number} on host`}
                      >
                        #{detail.number}
                        <ExternalLinkIcon aria-hidden className="size-2.5" />
                      </button>
                    }
                  />
                  <TooltipPopup side="top">{openOnHostText}</TooltipPopup>
                </Tooltip>
              </>
            ) : null}
          </div>
          <div
            aria-hidden={!condensed}
            inert={!condensed}
            className={cn(
              "col-start-1 row-start-1 flex min-w-0 items-center gap-1 text-sm text-muted-foreground transition-[opacity,transform] ease-out motion-reduce:transform-none motion-reduce:transition-none sm:text-xs",
              condensed
                ? "translate-y-0 opacity-100 delay-50 duration-150"
                : "pointer-events-none translate-y-1 opacity-0 duration-100",
            )}
          >
            {detail && statePresentation ? (
              <>
                {onBack ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-micro"
                          variant="ghost-muted"
                          tabIndex={condensed ? 0 : -1}
                          onClick={onBack}
                          className="-ml-1.5"
                          aria-label="Back to this thread's pull requests"
                        >
                          <ArrowLeftIcon aria-hidden className="size-3.5" />
                        </Button>
                      }
                    />
                    <TooltipPopup side="top">Back to pull requests</TooltipPopup>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        tabIndex={condensed ? 0 : -1}
                        onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}
                        onAuxClick={(event) => {
                          if (event.button === 1)
                            void readLocalApi()?.shell.openExternal(detail.url);
                        }}
                        onContextMenu={(event) => openNumberContextMenu(event, detail)}
                        className={cn(
                          "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 hover:underline",
                          statePresentation.toneClassName,
                        )}
                        aria-label={`Open pull request #${detail.number} on host`}
                      >
                        #{detail.number}
                        <ExternalLinkIcon aria-hidden className="size-2.5" />
                      </button>
                    }
                  />
                  <TooltipPopup side="top">{openOnHostText}</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {detail.title}
                      </span>
                    }
                  />
                  <TooltipPopup side="top">{detail.title}</TooltipPopup>
                </Tooltip>
              </>
            ) : null}
          </div>
        </div>
        <div className="mr-4 flex h-7 shrink-0 items-center justify-end gap-1">
          {detail ? (
            <TooltipProvider delay={150} closeDelay={150} timeout={400}>
              {!nativeStack && supportsStackActions && nativeStackQuery.error ? (
                <Button variant="ghost" size="xs" onClick={nativeStackQuery.refresh}>
                  Retry stack lookup
                </Button>
              ) : null}
              {nativeStack ? (
                <PullRequestStackMenu
                  hostLabel={hostClient.label}
                  stack={nativeStack}
                  notice={nativeStackQuery.notice}
                  onRetry={nativeStackQuery.error ? nativeStackQuery.refresh : undefined}
                  reference={reference}
                  environmentId={environmentId}
                  onSelect={onSelectPullRequest}
                  mergeMethod={selectedMergeMethod}
                  canMerge={
                    nativeStackQuery.isFresh &&
                    supportsStackActions &&
                    can("merge") &&
                    allowedMergeMethods.length > 0
                  }
                  canRebase={
                    nativeStackQuery.isFresh &&
                    supportsStackActions &&
                    detail.viewerPermissions.stackRebase === true
                  }
                  onActed={() => {
                    refreshDetail();
                    onActed?.();
                  }}
                />
              ) : null}
              {context === "page" ? (
                <PullRequestThreadLinks
                  display="count"
                  environmentId={environmentId}
                  reference={reference}
                  url={detail.url}
                  threadRef={null}
                />
              ) : null}
              {autoMergeArmed && primaryAction !== "auto-merge-armed" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Badge
                        size="control"
                        variant="info"
                        role="img"
                        aria-label={armedAutoMergeLabel}
                      >
                        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                        <span className="@max-[30rem]/pr-header:hidden">{armedAutoMergeLabel}</span>
                      </Badge>
                    }
                  />
                  <TooltipPopup side="top">
                    {armedAutoMergeLabel}: the host will merge this on its own once its requirements
                    are met
                  </TooltipPopup>
                </Tooltip>
              ) : null}
              {primaryAction === "resolve" ? (
                resolveConflictsControl
              ) : primaryAction === "ready" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0">
                        <Button
                          size="xs"
                          variant="default"
                          disabled={actionPending}
                          onClick={() => void perform("ready")}
                          aria-label="Ready for review"
                        >
                          <PullRequestGlyph.pullRequest aria-hidden className="size-3.5" />
                          <span className="@max-[30rem]/pr-header:hidden">Ready for review</span>
                        </Button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top">Ready for review</TooltipPopup>
                </Tooltip>
              ) : primaryAction === "enable-auto-merge" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0">
                        <Button
                          size="xs"
                          variant="default"
                          disabled={actionPending}
                          {...inlineConfirm.props(
                            "enable-auto-merge",
                            () => void perform("enable-auto-merge", selectedMergeMethod),
                          )}
                          aria-label={
                            pendingAction === "enable-auto-merge"
                              ? "Enabling..."
                              : inlineConfirm.isArmed("enable-auto-merge")
                                ? "Confirm auto-merge?"
                                : pendingAutoMergeLabel
                          }
                        >
                          {inlineConfirm.isArmed("enable-auto-merge") ? (
                            <CheckIcon aria-hidden className="size-3.5" />
                          ) : (
                            <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                          )}
                          <AnimatedWidth className="@max-[30rem]/pr-header:hidden">
                            <span className="grid">
                              <span aria-hidden className="invisible col-start-1 row-start-1">
                                {pendingAutoMergeLabel}
                              </span>
                              <span className="col-start-1 row-start-1">
                                {pendingAction === "enable-auto-merge"
                                  ? "Enabling..."
                                  : inlineConfirm.isArmed("enable-auto-merge")
                                    ? "Confirm auto-merge?"
                                    : pendingAutoMergeLabel}
                              </span>
                            </span>
                          </AnimatedWidth>
                        </Button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    {pendingAction === "enable-auto-merge"
                      ? "Enabling..."
                      : inlineConfirm.isArmed("enable-auto-merge")
                        ? "Confirm auto-merge?"
                        : pendingAutoMergeLabel}
                  </TooltipPopup>
                </Tooltip>
              ) : primaryAction === "auto-merge-armed" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Badge
                        size="control"
                        variant="info"
                        role="img"
                        aria-label={armedAutoMergeLabel}
                      >
                        <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                        <span className="@max-[30rem]/pr-header:hidden">{armedAutoMergeLabel}</span>
                      </Badge>
                    }
                  />
                  <TooltipPopup side="top">
                    {armedAutoMergeLabel}: the host will merge this on its own once its requirements
                    are met
                  </TooltipPopup>
                </Tooltip>
              ) : primaryAction === "merge" ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="inline-flex shrink-0">
                        <Button
                          size="xs"
                          variant="default"
                          disabled={actionPending}
                          {...inlineConfirm.props(
                            "merge",
                            () => void perform("merge", selectedMergeMethod),
                          )}
                          aria-label={
                            pendingAction === "merge"
                              ? "Merging..."
                              : inlineConfirm.isArmed("merge")
                                ? "Confirm merge?"
                                : selectedMergeMethodLabel
                          }
                        >
                          {inlineConfirm.isArmed("merge") ? (
                            <CheckIcon aria-hidden className="size-3.5" />
                          ) : (
                            <PullRequestGlyph.merged aria-hidden className="size-3.5" />
                          )}
                          <AnimatedWidth className="@max-[30rem]/pr-header:hidden">
                            <span className="grid">
                              <span aria-hidden className="invisible col-start-1 row-start-1">
                                {selectedMergeMethodLabel}
                              </span>
                              <span className="col-start-1 row-start-1">
                                {pendingAction === "merge"
                                  ? "Merging..."
                                  : inlineConfirm.isArmed("merge")
                                    ? "Confirm merge?"
                                    : selectedMergeMethodLabel}
                              </span>
                            </span>
                          </AnimatedWidth>
                        </Button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    {pendingAction === "merge"
                      ? "Merging..."
                      : inlineConfirm.isArmed("merge")
                        ? "Confirm merge?"
                        : selectedMergeMethodLabel}
                  </TooltipPopup>
                </Tooltip>
              ) : (primaryAction === "merged" || primaryAction === "closed") &&
                statePresentation !== null ? (
                <Badge size="control" variant="outline">
                  <span className={cn("flex items-center gap-1", statePresentation.toneClassName)}>
                    <statePresentation.Icon className="size-3.5" />
                    {statePresentation.label}
                  </span>
                </Badge>
              ) : null}
              {checkoutControl}
              <Menu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <MenuTrigger
                        render={
                          <Button
                            aria-label={
                              refreshing ? "Refreshing pull request" : "More pull request actions"
                            }
                            size="icon-xs"
                            variant="ghost-muted"
                          />
                        }
                      >
                        {refreshing ? (
                          <RefreshIcon refreshing size="md" />
                        ) : (
                          <MoreHorizontalIcon className="size-4" />
                        )}
                      </MenuTrigger>
                    }
                  />
                  <TooltipPopup>
                    {refreshing ? "Refreshing pull request" : "More pull request actions"}
                  </TooltipPopup>
                </Tooltip>
                <MenuPopup align="end" side="bottom">
                  <PullRequestThreadLinks
                    display="menu-item"
                    environmentId={environmentId}
                    reference={reference}
                    url={detail.url}
                    threadRef={
                      threadRef ??
                      (typeof composerDraftTarget === "object" ? composerDraftTarget : null)
                    }
                    onPickerOpenChange={setThreadPickerOpen}
                  />
                  <MenuItem disabled={refreshing} onClick={() => void refreshFromHost()}>
                    <RefreshIcon size="sm" refreshing={refreshing} />
                    Refresh
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={askAboutPullRequest}>
                    <MessageCircleQuestionIcon className="mt-1 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoff === "ask" ? "Opening..." : "Ask a question"}</span>
                      <span className="text-xs text-muted-foreground">
                        {attachTarget !== null
                          ? "Adds the pull request to this thread's composer."
                          : "Opens a thread that knows which pull request you mean."}
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem disabled={handoff !== null} onClick={explainPullRequest}>
                    <BookOpenIcon className="mt-1 size-3.5 shrink-0 self-start" />
                    <span className="flex min-w-0 flex-col">
                      <span>{handoff === "explain" ? "Opening..." : "Explain this PR"}</span>
                      <span className="text-xs text-muted-foreground">
                        A walk through the diff and what to read closely.
                      </span>
                    </span>
                  </MenuItem>
                  <MenuItem
                    disabled={handoff !== null || !canFixFindings}
                    onClick={startFixFindings}
                  >
                    <HammerIcon className="size-3.5" />
                    {handoff === "findings" ? "Preparing..." : handoffLabels.fixFindings}
                  </MenuItem>
                  {reviewGuidesEnabled && guideWriter.canWrite ? (
                    <MenuItem disabled={guideWriter.running} onClick={writeGuide}>
                      <SparklesIcon className="size-3.5" />
                      {guideWriter.running
                        ? "Writing guide..."
                        : guideWriter.data?.guide == null
                          ? "Write guide"
                          : "Rewrite guide"}
                    </MenuItem>
                  ) : null}
                  {pickableEnvironments.length > 0 ? (
                    <ActOnEnvironmentPicker
                      environments={pickableEnvironments}
                      value={actingEnvironmentId}
                      onChange={(next) => setActingScope({ pullRequestKey, environmentId: next })}
                      disabled={handoff !== null}
                    />
                  ) : null}
                  <MenuSeparator />
                  {detail.state === "open" ? (
                    <>
                      {showsDraftToggle ? (
                        <MenuItem
                          disabled={actionPending}
                          onClick={() => void perform(detail.isDraft ? "ready" : "draft")}
                        >
                          {detail.isDraft ? (
                            <PullRequestGlyph.pullRequest className="size-3.5" />
                          ) : (
                            <PullRequestGlyph.draft className="size-3.5" />
                          )}
                          {detail.isDraft ? "Ready for review" : "Convert to draft"}
                        </MenuItem>
                      ) : null}
                      {showsMergeNow ? (
                        <MenuItem
                          closeOnClick={inlineConfirm.isArmed("merge")}
                          aria-label={
                            inlineConfirm.isArmed("merge") ? "Confirm merge?" : "Merge now"
                          }
                          disabled={actionPending}
                          {...inlineConfirm.props(
                            "merge",
                            () => void perform("merge", selectedMergeMethod),
                          )}
                        >
                          <PullRequestGlyph.merged className="size-3.5" />
                          {inlineConfirm.isArmed("merge") ? "Confirm merge?" : "Merge now"}
                        </MenuItem>
                      ) : null}
                      {autoMergeArmed && can("disable-auto-merge") ? (
                        <MenuItem
                          disabled={actionPending}
                          onClick={() => void perform("disable-auto-merge")}
                        >
                          <PullRequestGlyph.merged className="size-3.5" />
                          Disable auto-merge
                        </MenuItem>
                      ) : showsAutoMerge ? (
                        <MenuItem
                          closeOnClick={inlineConfirm.isArmed("enable-auto-merge")}
                          aria-label={
                            inlineConfirm.isArmed("enable-auto-merge")
                              ? "Confirm auto-merge?"
                              : "Enable auto-merge"
                          }
                          disabled={actionPending}
                          {...inlineConfirm.props(
                            "enable-auto-merge",
                            () => void perform("enable-auto-merge", selectedMergeMethod),
                          )}
                        >
                          <PullRequestGlyph.merged className="size-3.5" />
                          {inlineConfirm.isArmed("enable-auto-merge")
                            ? "Confirm auto-merge?"
                            : "Enable auto-merge"}
                        </MenuItem>
                      ) : null}
                      {showsMergeMethods ? (
                        <>
                          {showsDraftToggle || showsMergeNow || showsAutoMerge ? (
                            <MenuSeparator />
                          ) : null}
                          <MenuRadioGroup
                            value={selectedMergeMethod}
                            onValueChange={(method) => {
                              const selectedMethod = method as PullRequestMergeMethod;
                              setMergeMethod(selectedMethod);
                              setLastSelectedMergeMethod(selectedMethod);
                            }}
                          >
                            {allowedMergeMethods.map((method) => (
                              <MenuRadioItem
                                key={method}
                                value={method}
                                disabled={actionPending}
                                closeOnClick
                              >
                                <span className="flex min-w-0 items-center gap-2">
                                  <PullRequestGlyph.merged className="size-3.5" />
                                  <span>{PULL_REQUEST_MERGE_METHOD_LABELS[method]}</span>
                                </span>
                              </MenuRadioItem>
                            ))}
                          </MenuRadioGroup>
                        </>
                      ) : null}
                      {pullRequestActionMenuHasGroup(
                        showsDraftToggle,
                        showsAutoMerge || showsMergeNow,
                        showsMergeMethods,
                      ) ? (
                        <MenuSeparator />
                      ) : null}
                    </>
                  ) : null}
                  <MenuItem onClick={() => void readLocalApi()?.shell.openExternal(detail.url)}>
                    <ArrowUpRightIcon className="size-3.5" />
                    {openOnHostText}
                  </MenuItem>
                  <MenuItem onClick={() => copyReference(detail.url, "PR link")}>
                    <LinkIcon className="size-3.5" />
                    Copy link
                    <MenuShortcut>
                      {shortcutLabelForCommand(keybindings, "thread.copyReference")}
                    </MenuShortcut>
                  </MenuItem>
                  <MenuItem onClick={() => copyReference(`#${reference.number}`, "PR number")}>
                    <CopyIcon className="size-3.5" />
                    Copy PR number
                    <MenuShortcut>
                      {shortcutLabelForCommand(keybindings, "pullRequest.copyNumber")}
                    </MenuShortcut>
                  </MenuItem>
                  {detail.state === "open" && can("close") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        closeOnClick={inlineConfirm.isArmed("close")}
                        aria-label={
                          inlineConfirm.isArmed("close") ? "Confirm close?" : "Close pull request"
                        }
                        variant="destructive"
                        disabled={actionPending}
                        {...inlineConfirm.props("close", () => void perform("close"))}
                      >
                        <PullRequestGlyph.closed className="size-3.5" />
                        {inlineConfirm.isArmed("close") ? "Confirm close?" : "Close pull request"}
                      </MenuItem>
                    </>
                  ) : detail.state === "closed" && can("reopen") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem disabled={actionPending} onClick={() => void perform("reopen")}>
                        <PullRequestGlyph.reopen className="size-3.5" />
                        Reopen pull request
                      </MenuItem>
                    </>
                  ) : detail.state === "merged" && can("revert") ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        closeOnClick={inlineConfirm.isArmed("revert")}
                        aria-label={
                          inlineConfirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"
                        }
                        variant={inlineConfirm.isArmed("revert") ? "destructive" : "default"}
                        disabled={actionPending}
                        {...inlineConfirm.props("revert", () => void perform("revert"))}
                      >
                        <RotateCcwIcon className="size-3.5" />
                        {inlineConfirm.isArmed("revert") ? "Confirm revert?" : "Revert changes"}
                      </MenuItem>
                    </>
                  ) : null}
                  {showsDeleteBranch ? (
                    <>
                      <MenuSeparator />
                      <MenuItem
                        variant="destructive"
                        disabled={actionPending || !environmentConnected}
                        onClick={() => void confirmDeleteBranch()}
                      >
                        <Trash2Icon className="mt-1 size-3.5 shrink-0 self-start" />
                        <span className="flex min-w-0 flex-col">
                          <span>
                            {pendingAction === "delete-branch"
                              ? "Deleting branch..."
                              : "Delete branch"}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {environmentConnected
                              ? detail.headBranch
                              : "Reconnect to delete this branch"}
                          </span>
                        </span>
                      </MenuItem>
                    </>
                  ) : null}
                </MenuPopup>
              </Menu>
            </TooltipProvider>
          ) : null}
          {onClose ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Collapse pull request panel"
              onClick={onClose}
            >
              <PanelRightIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[1fr]"
              : "grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={condensedRowRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "translate-y-0 opacity-100 delay-50"
                : "translate-y-1 opacity-0 duration-100",
            )}
            inert={!condensed}
          >
            {detail ? (
              <div className="col-span-2 min-w-0 px-4 pb-2 pt-1">
                <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex min-w-0 shrink items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
                    <PullRequestActorLabel
                      actor={detail.author}
                      profileUrl={authorProfileUrl}
                      variant="avatar"
                      className="shrink-0"
                    />
                    <span className="shrink-0">
                      <RelativeTime timestamp={detail.updatedAt} />
                    </span>
                  </span>
                  <span aria-hidden className="h-3 w-px shrink-0 bg-border/70" />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-2xs text-muted-foreground/65">
                    {freshness ? (
                      <PullRequestBaseFreshnessWarning
                        baseBranch={detail.baseBranch}
                        freshness={freshness}
                        pending={actionPending}
                        onUpdate={(method) => void perform("update-branch", undefined, method)}
                        iconClassName="size-3"
                        className="max-w-[40%]"
                      >
                        {isStackedPullRequest ? (
                          <PullRequestGlyph.stack
                            aria-label="Stacked pull request"
                            className="size-3 shrink-0"
                          />
                        ) : null}
                        <code className="flex min-w-0">
                          <MiddleTruncate value={detail.baseBranch} showTitle={false} />
                        </code>
                      </PullRequestBaseFreshnessWarning>
                    ) : (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
                              {isStackedPullRequest ? (
                                <PullRequestGlyph.stack
                                  aria-label="Stacked pull request"
                                  className="size-3 shrink-0"
                                />
                              ) : null}
                              <code className="flex min-w-0">
                                <MiddleTruncate value={detail.baseBranch} showTitle={false} />
                              </code>
                            </span>
                          }
                        />
                        <TooltipPopup side="top">
                          {isStackedPullRequest
                            ? `Stacked on ${detail.baseBranch}`
                            : detail.baseBranch}
                        </TooltipPopup>
                      </Tooltip>
                    )}
                    <ArrowLeftIcon
                      aria-label="receives changes from"
                      className="size-3 shrink-0 opacity-60"
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <code className="flex min-w-0 flex-1">
                            <MiddleTruncate value={detail.headBranch} showTitle={false} />
                          </code>
                        }
                      />
                      <TooltipPopup side="top">{detail.headBranch}</TooltipPopup>
                    </Tooltip>
                  </span>
                  <span className="ml-auto inline-flex shrink-0 items-center justify-end gap-2 text-2xs">
                    <span
                      className="inline-flex items-center gap-1 tabular-nums"
                      aria-label={`${detail.changedFiles.toLocaleString()} changed ${
                        detail.changedFiles === 1 ? "file" : "files"
                      }`}
                    >
                      <FileDiffIcon aria-hidden className="size-3" />
                      {detail.changedFiles.toLocaleString()}
                    </span>
                    <PullRequestChangeBreakdownStat
                      environmentId={environmentId}
                      reference={reference}
                      additions={detail.additions}
                      deletions={detail.deletions}
                      className="shrink-0 font-mono text-2xs"
                    />
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        <div
          className={cn(
            "col-span-2 grid",
            condensed
              ? "grid-rows-[0fr]"
              : "grid-rows-[1fr] transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
          )}
        >
          <div
            ref={foldRef}
            className={cn(
              "min-h-0 overflow-hidden transition-[opacity,transform] duration-150 ease-out motion-reduce:transform-none motion-reduce:transition-none",
              condensed
                ? "-translate-y-1 opacity-0 duration-100"
                : "translate-y-0 opacity-100 delay-50",
            )}
            inert={condensed}
          >
            {detail ? (
              <PullRequestDetailHeaderBody
                title={
                  titleDraft === null ? (
                    <PullRequestDetailTitleRow className="group gap-1">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <h1 className="min-w-0 flex-1 truncate text-base font-semibold leading-snug">
                              {detail.title}
                            </h1>
                          }
                        />
                        <TooltipPopup side="top">{detail.title}</TooltipPopup>
                      </Tooltip>
                      {canEditPullRequestChangeRequest(detail) ? (
                        <PullRequestEditButton
                          aria-label="Edit title"
                          onClick={() => setTitleScope({ pullRequestKey, text: detail.title })}
                        />
                      ) : null}
                    </PullRequestDetailTitleRow>
                  ) : (
                    <div className="space-y-2">
                      <Input
                        autoFocus
                        size="sm"
                        disabled={titleSaving}
                        value={titleDraft}
                        aria-label="Pull request title"
                        onChange={(event) =>
                          setTitleScope({ pullRequestKey, text: event.target.value })
                        }
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void saveTitle(titleDraft);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            setTitleScope(null);
                          }
                        }}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={titleSaving}
                          onClick={() => setTitleScope(null)}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={
                            !canWriteSourceControl || titleSaving || titleDraft.trim().length === 0
                          }
                          onClick={() => void saveTitle(titleDraft)}
                        >
                          {titleSaving ? "Saving..." : "Save"}
                        </Button>
                      </div>
                    </div>
                  )
                }
                author={
                  <PullRequestActorLabel actor={detail.author} profileUrl={authorProfileUrl} />
                }
                updated={
                  <span>
                    updated <RelativeTime timestamp={detail.updatedAt} />
                  </span>
                }
                checkout={
                  checkoutCommand ? (
                    <PullRequestCopyableCode
                      key={checkoutCommand}
                      value={checkoutCommand}
                      target="pull request checkout command"
                      copyLabel="Copy checkout command"
                      copiedLabel="Checkout command copied"
                      className="ml-auto font-mono"
                      tooltipSide="bottom"
                      onError={reportCheckoutCommandError}
                    />
                  ) : null
                }
                base={
                  freshness ? (
                    <PullRequestBaseFreshnessWarning
                      baseBranch={detail.baseBranch}
                      freshness={freshness}
                      pending={actionPending}
                      onUpdate={(method) => void perform("update-branch", undefined, method)}
                      className="max-w-[40%]"
                    >
                      {isStackedPullRequest ? (
                        <PullRequestGlyph.stack
                          aria-label="Stacked pull request"
                          className="size-3 shrink-0"
                        />
                      ) : null}
                      <code className="flex min-w-0">
                        <MiddleTruncate value={detail.baseBranch} showTitle={false} />
                      </code>
                    </PullRequestBaseFreshnessWarning>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1">
                            {isStackedPullRequest ? (
                              <PullRequestGlyph.stack
                                aria-label="Stacked pull request"
                                className="size-3 shrink-0"
                              />
                            ) : null}
                            <code className="flex min-w-0">
                              <MiddleTruncate value={detail.baseBranch} showTitle={false} />
                            </code>
                          </span>
                        }
                      />
                      <TooltipPopup side="top">
                        {isStackedPullRequest
                          ? `Stacked on ${detail.baseBranch}`
                          : detail.baseBranch}
                      </TooltipPopup>
                    </Tooltip>
                  )
                }
                head={
                  <PullRequestCopyableCode
                    key={detail.headBranch}
                    value={detail.headBranch}
                    target="branch name"
                    copyLabel="Copy pull request branch"
                    copiedLabel="Branch name copied"
                  />
                }
                files={`${detail.changedFiles.toLocaleString()} ${detail.changedFiles === 1 ? "file" : "files"}`}
                diffStat={
                  <PullRequestChangeBreakdownStat
                    environmentId={environmentId}
                    reference={reference}
                    additions={detail.additions}
                    deletions={detail.deletions}
                    className="shrink-0 font-mono text-xs"
                  />
                }
              />
            ) : null}
          </div>
        </div>

        {detail ? (
          <PullRequestDetailTabBar
            tabs={visibleTabs}
            value={tab}
            onValueChange={selectTab}
            onTabIntent={(item) => {
              if (item === "code") void loadCodeTab();
            }}
          >
            {tab === "summary" ? (
              showsApproveWorkflows ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span className="ml-auto inline-flex shrink-0">
                        <Button
                          size="xs"
                          variant="warning-outline"
                          disabled={actionPending}
                          {...inlineConfirm.props(
                            "approve-workflows",
                            () => void perform("approve-workflows"),
                          )}
                          aria-label={
                            pendingAction === "approve-workflows"
                              ? "Approving..."
                              : inlineConfirm.isArmed("approve-workflows")
                                ? "Confirm approve?"
                                : "Approve workflows to run"
                          }
                        >
                          <PlayIcon aria-hidden className="size-3.5" />
                          <span className="inline-grid">
                            <span aria-hidden className="invisible col-start-1 row-start-1">
                              Approve workflows to run
                            </span>
                            <span aria-hidden className="invisible col-start-1 row-start-1">
                              Confirm approve?
                            </span>
                            <span className="col-start-1 row-start-1">
                              {pendingAction === "approve-workflows"
                                ? "Approving..."
                                : inlineConfirm.isArmed("approve-workflows")
                                  ? "Confirm approve?"
                                  : "Approve workflows to run"}
                            </span>
                          </span>
                        </Button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    {pendingAction === "approve-workflows"
                      ? "Approving..."
                      : inlineConfirm.isArmed("approve-workflows")
                        ? "Confirm approve?"
                        : "Approve workflows to run"}
                  </TooltipPopup>
                </Tooltip>
              ) : (
                <PullRequestChecksStatusLine
                  className="text-muted-foreground"
                  aria-label={checksSummary ? `Checks: ${checksSummary}` : "Checks"}
                  icon={
                    checksState !== null ? (
                      <PullRequestChecksPopover
                        checks={detail.checks}
                        stale={checksStale}
                        checksState={checksState}
                        threadRef={threadRef}
                      />
                    ) : (
                      <CircleDotIcon aria-hidden className="size-3.5" />
                    )
                  }
                  label={checksSummary}
                />
              )
            ) : tab === "timeline" ? (
              <div className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                <PullRequestMetaLine
                  className={cn(
                    "whitespace-nowrap text-2xs transition-opacity",
                    (activityPending || activityError) && "opacity-35",
                  )}
                >
                  <span
                    className="inline-flex items-center gap-1"
                    aria-label={
                      activityError
                        ? "Comments unavailable"
                        : `${detail.commentCount.toLocaleString()} ${
                            detail.commentCount === 1 ? "comment" : "comments"
                          }`
                    }
                  >
                    <MessageSquareIcon aria-hidden className="size-3" />
                    {activityError
                      ? "—"
                      : activityPending
                        ? "…"
                        : detail.commentCount.toLocaleString()}
                  </span>
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
                      ? "—"
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
          </PullRequestDetailTabBar>
        ) : null}
      </div>

      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        onScrollCapture={(event) => {
          const scroller = scrollerByTab.current[tab];
          if (event.target !== scroller || scroller === null || scroller === undefined) return;
          const top = scroller.scrollTop;
          // Decided here, not in a state updater, which React may run during render.
          const previous = condensedByTab[tab] ?? false;
          const foldHeight = foldRef.current?.scrollHeight ?? 0;
          let next = previous;
          if (previous) {
            if (top < 4 && foldHeight > 0) next = false;
          } else if (foldHeight > 0 && top > foldHeight + 32) {
            const chromeDelta = foldHeight - (condensedRowRef.current?.scrollHeight ?? 0);
            compensationRef.current = { tab, scroller, target: top - chromeDelta };
            next = true;
          }
          if (next !== previous) setCondensedByTab({ ...condensedByTab, [tab]: next });
        }}
      >
        {detailQuery.error && !detail ? (
          <PullRequestsUnavailableState
            {...(isPullRequestNotFound(detailQuery.failure)
              ? {
                  title: `Pull request #${reference.number} not found`,
                  error:
                    "It may be an issue rather than a pull request, or this account can't see it.",
                }
              : { error: detailQuery.error })}
            refreshing={detailQuery.isPending}
            onRetry={refreshDetail}
            {...(unavailableGitHubUrl ? { gitHubUrl: unavailableGitHubUrl } : {})}
          />
        ) : detail ? (
          <PullRequestMarkdownContext value={markdownContext}>
            {mountedTabs.has("summary") ? (
              <div className={cn("absolute inset-0", tab !== "summary" && "invisible")}>
                <PullRequestSummaryTab
                  scrollerRef={scrollerRefs.summary}
                  environmentId={environmentId}
                  threadRef={threadRef}
                  reference={reference}
                  detail={detail}
                  activityPending={activityPending}
                  checksStale={checksStale}
                  activityError={activityError}
                  pendingFinding={handoff}
                  fixFindingLabel={handoffLabels.fixFinding}
                  fixCheckLabel={handoffLabels.fixCheck}
                  {...(canFixFindings ? { onFixFinding: startFixFinding } : {})}
                  onRefresh={refreshDetail}
                  onRefreshChecks={refreshFromHost}
                />
              </div>
            ) : null}
            {mountedTabs.has("guide") ? (
              <div className={cn("absolute inset-0", tab !== "guide" && "invisible")}>
                <PullRequestGuideTab
                  environmentId={environmentId}
                  reference={reference}
                  active={tab === "guide"}
                  title={detail.title}
                  workspaceRoot={detail.workspaceRoot}
                  canComment={
                    detail.capabilities.review.inlineComment && detail.viewerPermissions.comment
                  }
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
                    onRetry={activityQuery.refresh}
                  />
                ) : (
                  <PullRequestTimelineTab
                    scrollerRef={scrollerRefs.timeline}
                    detail={detail}
                    environmentId={environmentId}
                    threadRef={threadRef}
                    reference={reference}
                    order={timelineOrder}
                    onOpenCommit={openCommit}
                    onRefresh={refreshDetail}
                  />
                )}
              </div>
            ) : null}
            {mountedTabs.has("code") ? (
              <div className={cn("absolute inset-0", tab !== "code" && "invisible")}>
                <Suspense fallback={<DiffPanelLoadingState label="Loading pull request diff..." />}>
                  <PullRequestCodeTab
                    scrollerRef={scrollerRefs.code}
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

      {detail ? (
        <div className="absolute right-4 bottom-3 z-20">
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
