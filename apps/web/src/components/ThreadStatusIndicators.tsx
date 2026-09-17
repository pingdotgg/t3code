import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";

import { pullRequestDetailToVcsStatus } from "@t3tools/client-runtime/state/pull-requests";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { FolderGit2Icon, TerminalIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject } from "../state/entities";
import {
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
  type ThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";
import { type MouseEvent } from "react";
import { buttonVariants, InlineButton } from "./ui/button";
import { cn } from "../lib/utils";

import { parseChangeRequestUrl } from "../lib/openPullRequestLink";
import { useEnvironmentQuery } from "../state/query";
import { linkedPullRequestDetailAtom, useSharedPullRequestSummary } from "../state/pullRequests";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { vcsEnvironment } from "../state/vcs";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import {
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type ThreadStatusPill,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
} from "./Sidebar.logic";

import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { pullRequestListLines } from "./pullRequest/pullRequestListLines";
import {
  PULL_REQUEST_STATE_PRESENTATION,
  PullRequestGlyph,
  type PullRequestGlyphIcon,
} from "./pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  Icon: PullRequestGlyphIcon;
  tooltip: string;
  tooltipLead: string;
  tooltipTitle: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export interface LinkedThreadPullRequestStatus {
  readonly pr: NonNullable<ThreadPr>;
  readonly sourceControlProvider: NonNullable<VcsStatusResult["sourceControlProvider"]>;
}

/** Linked badges use persisted snapshots; only branch and legacy fallbacks lease summary reads. */
export function useLinkedThreadPullRequest(
  environmentId: EnvironmentId | null,
  linkedPullRequest: ThreadLinkedPullRequest | null | undefined,
  enabled = true,
  pullRequests?: ReadonlyArray<ThreadPullRequestLink>,
  branchPullRequest?: ThreadLinkedPullRequest | null,
): LinkedThreadPullRequestStatus | null {
  const supportsLinks = useSupportsMultiplePullRequests(environmentId);
  const current = useMemo(
    () => (supportsLinks ? resolveThreadCurrentPullRequestLink(pullRequests ?? []) : null),
    [pullRequests, supportsLinks],
  );
  const fallback =
    current === null ? ((!supportsLinks ? linkedPullRequest : null) ?? branchPullRequest) : null;
  const host = fallback == null ? undefined : parseChangeRequestUrl(fallback.url)?.host;
  const reference =
    fallback == null ? null : { ...fallback, ...(host === undefined ? {} : { host }) };
  const queried = useEnvironmentQuery(
    !enabled || environmentId === null || reference === null
      ? null
      : linkedPullRequestDetailAtom({ environmentId, input: reference }),
  ).data;
  const detail = useSharedPullRequestSummary(environmentId, reference, queried);

  return useMemo(() => {
    if (current !== null) return linkedPullRequestSnapshotStatus(current);
    return detail === null
      ? null
      : {
          pr: pullRequestDetailToVcsStatus(detail),
          sourceControlProvider: { kind: detail.provider, name: detail.provider, baseUrl: "" },
        };
  }, [current, detail]);
}

export function linkedPullRequestSnapshotStatus(
  link: ThreadPullRequestLink,
): LinkedThreadPullRequestStatus | null {
  const snapshot = link.snapshot;
  if (snapshot === null) return null;
  const kind = link.url.includes("/-/merge_requests/")
    ? "gitlab"
    : link.url.includes("/pullrequest/")
      ? "azure-devops"
      : link.url.includes("/pull-requests/")
        ? "bitbucket"
        : link.url.includes("/pulls/")
          ? "forgejo"
          : "github";
  return {
    pr: {
      number: link.number,
      url: link.url,
      title: snapshot.title,
      state: snapshot.state,
      isDraft: snapshot.isDraft,
      headRef: snapshot.headBranch,
      baseRef: snapshot.baseBranch,
      ...(snapshot.updatedAt === null ? {} : { updatedAt: snapshot.updatedAt }),
    },
    sourceControlProvider: { kind, name: kind, baseUrl: "" },
  };
}

export {
  resolveThreadPullRequestBadge,
  type ThreadPullRequestBadge,
} from "@t3tools/shared/threadPullRequests";

export interface ThreadPullRequestBadgePresentation {
  readonly Icon: PullRequestGlyphIcon;
  readonly toneClassName: string;
  readonly label: string;
  readonly text: string | number;
}

/** Resolve the complete badge appearance before rendering it in the sidebar or composer. */
export function resolveThreadPullRequestBadgePresentation({
  badge,
  number,
  url,
  status,
}: {
  readonly badge: ThreadPullRequestBadge | null;
  readonly number?: number | undefined;
  readonly url?: string | undefined;
  readonly status: PrStatusIndicator | null;
}): ThreadPullRequestBadgePresentation | null {
  // The badge already folds every visible link into one state, draft included, so both the
  // stack and the linked count index the shared table directly rather than the single-PR resolver.
  if (badge?.kind === "stack") {
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: PullRequestGlyph.stack,
      toneClassName: aggregate.toneClassName,
      label: `Stack of ${badge.layers} pull requests, ${aggregate.label.toLowerCase()}`,
      text: badge.layers,
    };
  }
  if (number === undefined || url === undefined) return null;

  const tooltip = status?.tooltip ?? `PR #${number}, status pending`;
  if (badge?.kind === "pull-request" && badge.others > 0) {
    // Unrelated links fold into one state, so a count of merged PRs reads as merged.
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: aggregate.Icon,
      toneClassName: aggregate.toneClassName,
      label: `${tooltip}, and ${badge.others} more linked; overall ${aggregate.label.toLowerCase()}`,
      text: `+${badge.others + 1}`,
    };
  }
  return {
    Icon: status?.Icon ?? PullRequestGlyph.pullRequest,
    toneClassName: status?.colorClass ?? "text-muted-foreground",
    label: tooltip,
    text: number,
  };
}

/** The complete linked-PR control shared by the sidebar and composer footer. */
export function ThreadPullRequestBadgeControl({
  variant,
  badge,
  pullRequests,
  number,
  url,
  status,
  onOpenStack,
  onOpenPullRequest,
}: {
  variant: "underline" | "ghost";
  badge: ThreadPullRequestBadge | null;
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  number?: number | undefined;
  url?: string | undefined;
  status: PrStatusIndicator | null;
  onOpenStack: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const presentation = resolveThreadPullRequestBadgePresentation({ badge, number, url, status });
  if (presentation === null) return null;
  const isStack = badge?.kind === "stack";
  const showList = isStack || (badge?.kind === "pull-request" && badge.others > 0);
  const className = cn(
    variant === "ghost"
      ? buttonVariants({ variant: "ghost", size: "xs" })
      : "inline-flex shrink-0 cursor-pointer items-center gap-0.5 whitespace-nowrap border-b border-transparent hover:border-current focus-visible:outline-2 focus-visible:outline-ring",
    "text-xs tabular-nums",
    variant === "ghost" &&
      "font-normal text-xs! active:scale-100 [--control-icon-color:currentColor]",
    presentation.toneClassName,
  );
  const content = (
    <>
      <presentation.Icon aria-hidden className="size-3 shrink-0" />
      {presentation.text}
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          isStack ? (
            <InlineButton
              className={className}
              aria-label={presentation.label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onOpenStack();
              }}
            />
          ) : (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className={className}
              aria-label={presentation.label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onOpenPullRequest}
            />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipPopup
        side="top"
        variant={showList ? "glass" : "default"}
        className={
          showList ? "w-80 max-w-[calc(100vw-2rem)] text-left whitespace-normal" : undefined
        }
      >
        {showList ? <ThreadPullRequestsMiniList pullRequests={pullRequests} /> : presentation.label}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * A miniature of the pull-requests panel for the thread tooltip: same order, same indentation,
 * so the hover answers "what is in here" without opening the surface.
 */
export function ThreadPullRequestsMiniList({
  pullRequests,
}: {
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}) {
  const lines = useMemo(
    () =>
      pullRequestListLines(resolveThreadPullRequestChains(visibleThreadPullRequests(pullRequests))),
    [pullRequests],
  );
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {lines.map((line) => {
        const snapshot = line.link.snapshot;
        const presentation =
          snapshot === null
            ? null
            : resolvePullRequestState({ state: snapshot.state, isDraft: snapshot.isDraft });
        return (
          <li
            key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
            className="flex min-w-0 items-center gap-2"
            // Capped like the panel: past a few layers the indent only repeats "still in the
            // stack", and sixteen of them would walk the titles off the popover.
            style={{ paddingLeft: `${Math.min(line.depth, 3) * 0.75}rem` }}
          >
            {presentation ? (
              <presentation.Icon
                aria-hidden
                className={cn("size-3 shrink-0", presentation.toneClassName)}
              />
            ) : (
              <PullRequestGlyph.pullRequest
                aria-hidden
                className="size-3 shrink-0 stroke-muted-foreground"
              />
            )}
            <span className="shrink-0 font-mono tabular-nums">#{line.link.number}</span>
            <span className="min-w-0 truncate text-foreground/75">
              {snapshot?.title ?? line.link.repository}
            </span>
            {line.stack ? (
              <span className="ml-auto shrink-0 pl-1 text-[10px]">
                {line.stack.kind === "native" ? "stack" : "chain"} · {line.stack.size}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);
  const state = resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft === true });

  const tooltipLead = `${presentation.shortName} #${pr.number} - ${state.label}`;
  return {
    label: `${presentation.shortName} ${state.label.toLowerCase()}`,
    colorClass: state.toneClassName,
    Icon: state.Icon,
    tooltip: `${tooltipLead}: ${pr.title}`,
    tooltipLead,
    tooltipTitle: pr.title,
    url: pr.url,
  };
}

export function ChangeRequestStatusIcon({
  state,
  isDraft = false,
  className,
}: Pick<NonNullable<ThreadPr>, "state"> & {
  readonly isDraft?: boolean | undefined;
  readonly className?: string | undefined;
}) {
  const presentation = resolvePullRequestState({ state, isDraft });
  return <presentation.Icon className={className} />;
}

export function PrStatusTooltipContent({ status }: { status: PrStatusIndicator }) {
  return (
    <span className="flex max-w-[min(34rem,calc(100vw-2rem))] items-stretch overflow-hidden whitespace-nowrap">
      <span className="shrink-0 pr-2 font-medium">{status.tooltipLead}</span>
      <span className="min-h-4 shrink-0 border-border/70 border-l" aria-hidden="true" />
      <span className="min-w-0 truncate pl-2">{status.tooltipTitle}</span>
    </span>
  );
}

export function resolveThreadPr(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
}): ThreadPr | null {
  const { threadBranch, gitStatus } = input;
  if (gitStatus === null) {
    return null;
  }

  if (threadBranch === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

/**
 * Parent-held PR snapshot for Sidebar V2. Rows remount when settlement
 * partitions move them, so terminal PR metadata must live above the row.
 */
export interface ThreadChangeRequestSnapshot {
  readonly branch: string;
  readonly pr: NonNullable<ThreadPr>;
  readonly sourceControlProvider: VcsStatusResult["sourceControlProvider"] | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest;
}

export const threadChangeRequestSnapshotsAtom = Atom.make<
  ReadonlyMap<string, ThreadChangeRequestSnapshot>
>(new Map()).pipe(Atom.keepAlive, Atom.withLabel("sidebar:thread-change-request-snapshots"));

function isTerminalChangeRequestState(
  state: NonNullable<ThreadPr>["state"],
): state is "merged" | "closed" {
  return state === "merged" || state === "closed";
}

function sourceControlProvidersEqual(
  left: VcsStatusResult["sourceControlProvider"] | undefined,
  right: VcsStatusResult["sourceControlProvider"] | undefined,
): boolean {
  if (left === right) return true;
  if (left == null || right == null) return left == null && right == null;
  return left.kind === right.kind && left.name === right.name && left.baseUrl === right.baseUrl;
}

function linkedPullRequestsEqual(
  left: ThreadLinkedPullRequest | null | undefined,
  right: ThreadLinkedPullRequest | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left.projectId === right.projectId &&
    left.repository === right.repository &&
    left.number === right.number &&
    left.url === right.url
  );
}

export function threadChangeRequestSnapshotsEqual(
  left: ThreadChangeRequestSnapshot,
  right: ThreadChangeRequestSnapshot,
): boolean {
  return (
    left.branch === right.branch &&
    left.pr.number === right.pr.number &&
    left.pr.title === right.pr.title &&
    left.pr.url === right.pr.url &&
    left.pr.baseRef === right.pr.baseRef &&
    left.pr.headRef === right.pr.headRef &&
    left.pr.state === right.pr.state &&
    left.pr.isDraft === right.pr.isDraft &&
    (left.pr.updatedAt ?? null) === (right.pr.updatedAt ?? null) &&
    sourceControlProvidersEqual(left.sourceControlProvider, right.sourceControlProvider) &&
    linkedPullRequestsEqual(left.linkedPullRequest, right.linkedPullRequest)
  );
}

export function setThreadChangeRequestSnapshot(
  threadKey: string,
  snapshot: ThreadChangeRequestSnapshot | null,
): void {
  appAtomRegistry.modify(threadChangeRequestSnapshotsAtom, (current) => {
    const existing = current.get(threadKey);
    if (snapshot === null) {
      if (existing === undefined) return [false, current];
      const next = new Map(current);
      next.delete(threadKey);
      return [true, next];
    }
    if (existing !== undefined && threadChangeRequestSnapshotsEqual(existing, snapshot)) {
      return [false, current];
    }
    const next = new Map(current);
    next.set(threadKey, snapshot);
    return [true, next];
  });
}

/**
 * Authoritative snapshot update from live VCS status.
 * - `undefined`: missing status, or a local checkout retaining a terminal PR — leave the map alone
 * - `null`: no PR (without a retained terminal snapshot), a cleared branch, or a mismatch without a terminal PR — clear
 * - snapshot: matching branch reports a PR — store/replace
 */
export function nextThreadChangeRequestSnapshot(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  snapshot: ThreadChangeRequestSnapshot | null | undefined;
  retainTerminalOnBranchMismatch: boolean;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): ThreadChangeRequestSnapshot | null | undefined {
  const {
    threadBranch,
    gitStatus,
    snapshot,
    retainTerminalOnBranchMismatch,
    linkedPullRequest,
    linkedPullRequestStatus,
  } = input;
  if (linkedPullRequest != null) {
    if (linkedPullRequestStatus === null || linkedPullRequestStatus === undefined) {
      return linkedPullRequestsEqual(snapshot?.linkedPullRequest, linkedPullRequest)
        ? undefined
        : null;
    }
    return {
      branch: threadBranch ?? linkedPullRequestStatus.pr.headRef,
      pr: linkedPullRequestStatus.pr,
      sourceControlProvider: linkedPullRequestStatus.sourceControlProvider,
      linkedPullRequest,
    };
  }
  if (gitStatus === null) {
    return snapshot?.linkedPullRequest === undefined ? undefined : null;
  }
  if (threadBranch === null) {
    return null;
  }
  if (gitStatus.refName !== threadBranch) {
    return retainTerminalOnBranchMismatch &&
      snapshot != null &&
      snapshot.linkedPullRequest === undefined &&
      isTerminalChangeRequestState(snapshot.pr.state)
      ? undefined
      : null;
  }
  if (gitStatus.pr == null) {
    if (
      retainTerminalOnBranchMismatch &&
      snapshot != null &&
      snapshot.linkedPullRequest === undefined &&
      isTerminalChangeRequestState(snapshot.pr.state)
    ) {
      return undefined;
    }
    return null;
  }
  return {
    branch: threadBranch,
    pr: gitStatus.pr,
    sourceControlProvider: gitStatus.sourceControlProvider,
  };
}

/**
 * Live PR when the checkout matches the thread branch; otherwise, for local
 * checkouts only, a cached merged/closed PR for the thread. Local thread
 * metadata follows the shared checkout, so the cached branch intentionally
 * survives that metadata changing to the newly checked-out branch. Open PRs
 * are retained only while live status is absent and the branch still matches.
 */
export function resolveDisplayedThreadPr(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  snapshot: ThreadChangeRequestSnapshot | null | undefined;
  retainTerminalOnBranchMismatch: boolean;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): ThreadPr | null {
  const {
    threadBranch,
    gitStatus,
    snapshot,
    retainTerminalOnBranchMismatch,
    linkedPullRequest,
    linkedPullRequestStatus,
  } = input;
  if (linkedPullRequest != null) {
    return (
      linkedPullRequestStatus?.pr ??
      (linkedPullRequestsEqual(snapshot?.linkedPullRequest, linkedPullRequest)
        ? (snapshot?.pr ?? null)
        : null)
    );
  }
  if (
    threadBranch !== null &&
    gitStatus !== null &&
    gitStatus.refName === threadBranch &&
    gitStatus.pr != null
  ) {
    return gitStatus.pr;
  }

  if (
    gitStatus === null &&
    threadBranch !== null &&
    snapshot?.branch === threadBranch &&
    snapshot.linkedPullRequest === undefined
  ) {
    return snapshot.pr;
  }

  if (
    threadBranch !== null &&
    retainTerminalOnBranchMismatch &&
    snapshot != null &&
    snapshot.linkedPullRequest === undefined &&
    isTerminalChangeRequestState(snapshot.pr.state)
  ) {
    return snapshot.pr;
  }

  return null;
}

export function resolveDisplayedThreadPrProvider(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  snapshot: ThreadChangeRequestSnapshot | null | undefined;
  retainTerminalOnBranchMismatch: boolean;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): VcsStatusResult["sourceControlProvider"] | undefined {
  const {
    threadBranch,
    gitStatus,
    snapshot,
    retainTerminalOnBranchMismatch,
    linkedPullRequest,
    linkedPullRequestStatus,
  } = input;
  if (linkedPullRequest != null) {
    return (
      linkedPullRequestStatus?.sourceControlProvider ??
      (linkedPullRequestsEqual(snapshot?.linkedPullRequest, linkedPullRequest)
        ? snapshot?.sourceControlProvider
        : undefined)
    );
  }
  if (
    threadBranch !== null &&
    gitStatus !== null &&
    gitStatus.refName === threadBranch &&
    gitStatus.pr != null
  ) {
    return gitStatus.sourceControlProvider;
  }

  if (
    gitStatus === null &&
    threadBranch !== null &&
    snapshot?.branch === threadBranch &&
    snapshot.linkedPullRequest === undefined
  ) {
    return snapshot.sourceControlProvider;
  }

  if (
    threadBranch !== null &&
    retainTerminalOnBranchMismatch &&
    snapshot != null &&
    snapshot.linkedPullRequest === undefined &&
    isTerminalChangeRequestState(snapshot.pr.state)
  ) {
    return snapshot.sourceControlProvider;
  }

  return undefined;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function ThreadWorktreeIndicator({
  thread,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath) {
    return null;
  }

  const displayPath = formatWorktreePathForDisplay(worktreePath);
  const tooltip = thread.branch
    ? `Worktree: ${displayPath} (${thread.branch})`
    : `Worktree: ${displayPath}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={tooltip}
            data-testid={`thread-worktree-${thread.id}`}
            className="inline-flex items-center justify-center"
          />
        }
      >
        <FolderGit2Icon className="size-3 text-muted-foreground/40" />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-status-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-status-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({
  thread,
  snapshot,
}: {
  thread: SidebarThreadSummary;
  snapshot?: ThreadChangeRequestSnapshot | undefined;
}) {
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(false);
  // Observe the containing title even when this thread has no badge yet.
  const statusRef = useCallback(
    (node: HTMLSpanElement | null) => rowRef(node?.parentElement ?? null),
    [rowRef],
  );
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const linkedPullRequest = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
  );
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus &&
      thread.linkedPullRequest == null &&
      (thread.branch != null || thread.worktreePath !== null) &&
      gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const displayedPrInput = {
    threadBranch: thread.branch,
    gitStatus: visibleGitStatus,
    snapshot,
    retainTerminalOnBranchMismatch: thread.worktreePath === null,
    linkedPullRequest: thread.linkedPullRequest,
    linkedPullRequestStatus: linkedPullRequest,
  };
  const pr = resolveDisplayedThreadPr(displayedPrInput);
  const prStatus = prStatusIndicator(pr, resolveDisplayedThreadPrProvider(displayedPrInput));
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const pendingLink =
    pr === null && supportsMultiplePullRequests
      ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
      : null;

  return (
    <span
      ref={statusRef}
      className={
        prStatus || threadStatus ? "inline-flex shrink-0 items-center gap-1.5" : "contents"
      }
    >
      {prStatus && pr ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <ChangeRequestStatusIcon state={pr.state} isDraft={pr.isDraft} className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            <PrStatusTooltipContent status={prStatus} />
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {pendingLink ? (
        <PullRequestGlyph.pullRequest
          className="size-3 text-muted-foreground"
          aria-label={`PR #${pendingLink.number}, status pending`}
        />
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // No primary (the hosted app) means every thread is remote, and the machine
  // glyph is what tells the environments apart.
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread ? (remoteEnvLabel ?? "Remote") : null;
  const remoteMachine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "animate-status-pulse" : ""}`}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? "Remote"}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <EnvironmentMachineIcon
              kind={remoteMachine}
              className="size-3 text-muted-foreground/60"
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
