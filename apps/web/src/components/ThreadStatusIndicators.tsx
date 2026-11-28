import { pipe } from "effect/Function";
import { changeRequestTermKind, type ChangeRequestTermKind } from "./pullRequest/changeRequestTerm";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { useStableCallback } from "~/hooks/useStableCallback";

import { pullRequestDetailToVcsStatus } from "@t3tools/client-runtime/state/pull-requests";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { TerminalIcon } from "lucide-react";
import { m, type MessageResolver } from "../i18n/messages";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { useProject } from "../state/entities";
import {
  pullRequestListLines,
  resolveThreadCurrentPullRequestLink,
  resolveThreadPullRequestBadge,
  resolveThreadPullRequestChains,
  type ThreadPullRequestBadge,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import { useRender } from "@base-ui/react/use-render";
import {
  type ComponentType,
  type ReactNode,
  type AnimationEvent,
  type MouseEvent,
  type ReactElement,
} from "react";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { revealThreadTerminal } from "../lib/revealThreadTerminal";

import { useEnvironmentQuery } from "../state/query";
import { linkedPullRequestDetailAtom, useSharedPullRequestSummary } from "../state/pullRequests";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { vcsEnvironment } from "../state/vcs";
import { useUiStateStore } from "../uiStateStore";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  pullRequestMatchesSearchQuery,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type ThreadStatusPill,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
} from "./Sidebar.logic";

import type { SidebarThreadSummary } from "../types";
import { SharedTooltipTrigger } from "./ui/shared-tooltip";
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
  label: string;
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export interface LinkedThreadPullRequestStatus {
  readonly pr: NonNullable<ThreadPr>;
  readonly sourceControlProvider: NonNullable<VcsStatusResult["sourceControlProvider"]>;
}

export function useLinkedThreadPullRequest(
  environmentId: EnvironmentId | null,
  linkedPullRequest: ThreadLinkedPullRequest | null | undefined,
  enabled = true,
  pullRequests?: ReadonlyArray<ThreadPullRequestLink>,
  branchPullRequest?: ThreadLinkedPullRequest | null,
): LinkedThreadPullRequestStatus | null {
  const supportsLinks = useSupportsMultiplePullRequests(environmentId);
  const current = supportsLinks ? resolveThreadCurrentPullRequestLink(pullRequests ?? []) : null;
  const currentStatus = current === null ? null : linkedPullRequestSnapshotStatus(current);
  const fallback =
    current === null ? ((!supportsLinks ? linkedPullRequest : null) ?? branchPullRequest) : null;
  // Preserve reference identity so sidebar renders do not touch the summary cache.
  const reference = fallback == null ? null : linkedPullRequestReference(fallback);
  // Mounted for its answers, which land in the shared summary read below.
  useEnvironmentQuery(
    !enabled || environmentId === null || reference === null
      ? null
      : linkedPullRequestDetailAtom({ environmentId, input: reference }),
  );
  const detail = useSharedPullRequestSummary(environmentId, reference);

  if (current !== null) return currentStatus;
  return detail === null
    ? null
    : {
        pr: pullRequestDetailToVcsStatus(detail),
        sourceControlProvider: {
          kind: detail.provider,
          name: sourceControlClients.get(detail.provider).label,
          baseUrl: "",
        },
      };
}

/** The pull request a thread shows: its current link, else the one found for its branch. */
export function useThreadDisplayedPullRequest(
  environmentId: EnvironmentId,
  thread: Pick<
    EnvironmentThreadShell,
    "pullRequests" | "linkedPullRequest" | "branchPullRequest"
  > | null,
  branchPr: ThreadPr = null,
  branchSourceControlProvider?: VcsStatusResult["sourceControlProvider"],
) {
  const m = useMessages();
  const supportsLinks = useSupportsMultiplePullRequests(environmentId);
  const linkedStatus = useLinkedThreadPullRequest(
    environmentId,
    thread?.linkedPullRequest,
    true,
    thread?.pullRequests,
    thread?.branchPullRequest,
  );
  const currentLink = supportsLinks
    ? resolveThreadCurrentPullRequestLink(thread?.pullRequests ?? [])
    : null;
  const pr = linkedStatus?.pr ?? (currentLink === null ? branchPr : null);
  return {
    currentLink,
    badge: supportsLinks ? resolveThreadPullRequestBadge(thread?.pullRequests) : null,
    pr,
    status: prStatusIndicator(
      pr,
      linkedStatus?.sourceControlProvider ?? branchSourceControlProvider,
      m,
    ),
    number: currentLink?.number ?? pr?.number,
    url: currentLink?.url ?? pr?.url,
  };
}

function linkedPullRequestReference(fallback: ThreadLinkedPullRequest) {
  const host = sourceControlClients.parseChangeRequestUrl(fallback.url)?.link.host;
  return { ...fallback, ...(host === undefined ? {} : { host }) };
}

function changeRequestTerminologyForUrl(url: string | undefined) {
  const host = url === undefined ? null : sourceControlClients.findByChangeRequestUrl(url);
  return (host ?? sourceControlClients.get(undefined)).changeRequest;
}

export function linkedPullRequestSnapshotStatus(
  link: ThreadPullRequestLink,
): LinkedThreadPullRequestStatus | null {
  const snapshot = link.snapshot;
  if (snapshot === null) return null;
  const kind = (
    sourceControlClients.findByChangeRequestUrl(link.url) ?? sourceControlClients.get(undefined)
  ).kind;
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
} from "@t3tools/client-runtime/thread-pull-requests";

export interface ThreadPullRequestBadgePresentation {
  readonly Icon: PullRequestGlyphIcon;
  readonly toneClassName: string;
  readonly label: string;
  readonly text: string | number;
}

type PullRequestBadgeState = ThreadPullRequestBadge["state"];

function stackBadgeLabel(
  state: PullRequestBadgeState,
  count: number,
  term: ChangeRequestTermKind,
  resolve: MessageResolver,
): string {
  switch (state) {
    case "open":
      return resolve(
        msg(
          "{count, plural, one {Stack of {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}, open} other {Stack of {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}, open}}",
          { count, term },
        ),
      );
    case "draft":
      return resolve(
        msg(
          "{count, plural, one {Stack of {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}, draft} other {Stack of {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}, draft}}",
          { count, term },
        ),
      );
    case "closed":
      return resolve(
        msg(
          "{count, plural, one {Stack of {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}, closed} other {Stack of {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}, closed}}",
          { count, term },
        ),
      );
    case "merged":
      return resolve(
        msg(
          "{count, plural, one {Stack of {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}, merged} other {Stack of {count} {term, select, mr {merge requests} cr {change requests} other {pull requests}}, merged}}",
          { count, term },
        ),
      );
  }
}

function moreLinkedBadgeLabel(
  state: PullRequestBadgeState,
  tooltip: string,
  others: number,
  resolve: MessageResolver,
): string {
  switch (state) {
    case "open":
      return resolve(
        msg(
          "{others, plural, one {{tooltip}, and {others} more linked; overall open} other {{tooltip}, and {others} more linked; overall open}}",
          { tooltip, others },
        ),
      );
    case "draft":
      return resolve(
        msg(
          "{others, plural, one {{tooltip}, and {others} more linked; overall draft} other {{tooltip}, and {others} more linked; overall draft}}",
          { tooltip, others },
        ),
      );
    case "closed":
      return resolve(
        msg(
          "{others, plural, one {{tooltip}, and {others} more linked; overall closed} other {{tooltip}, and {others} more linked; overall closed}}",
          { tooltip, others },
        ),
      );
    case "merged":
      return resolve(
        msg(
          "{others, plural, one {{tooltip}, and {others} more linked; overall merged} other {{tooltip}, and {others} more linked; overall merged}}",
          { tooltip, others },
        ),
      );
  }
}

function prStatusLabels(
  state: PullRequestBadgeState,
  term: ChangeRequestTermKind,
  number: number,
  resolve: MessageResolver,
): { readonly label: string; readonly tooltipLead: string } {
  switch (state) {
    case "open":
      return {
        label: resolve(
          msg("{term, select, mr {MR} cr {change request} other {PR}} open", { term }),
        ),
        tooltipLead: resolve(
          msg("{term, select, mr {MR} cr {change request} other {PR}} #{number} - Open", {
            term,
            number,
          }),
        ),
      };
    case "draft":
      return {
        label: resolve(
          msg("{term, select, mr {MR} cr {change request} other {PR}} draft", { term }),
        ),
        tooltipLead: resolve(
          msg("{term, select, mr {MR} cr {change request} other {PR}} #{number} - Draft", {
            term,
            number,
          }),
        ),
      };
    case "closed":
      return {
        label: resolve(
          msg("{term, select, mr {MR} cr {change request} other {PR}} closed", { term }),
        ),
        tooltipLead: resolve(
          msg("{term, select, mr {MR} cr {change request} other {PR}} #{number} - Closed", {
            term,
            number,
          }),
        ),
      };
    case "merged":
      return {
        label: resolve(
          msg("{term, select, mr {MR} cr {change request} other {PR}} merged", { term }),
        ),
        tooltipLead: resolve(
          msg("{term, select, mr {MR} cr {change request} other {PR}} #{number} - Merged", {
            term,
            number,
          }),
        ),
      };
  }
}

function resolveThreadPullRequestBadgePresentation(
  {
    badge,
    number,
    url,
    status,
  }: {
    readonly badge: ThreadPullRequestBadge | null;
    readonly number?: number | undefined;
    readonly url?: string | undefined;
    readonly status: PrStatusIndicator | null;
  },
  resolve: MessageResolver = m,
): ThreadPullRequestBadgePresentation | null {
  const terminology = changeRequestTerminologyForUrl(url);
  if (badge?.kind === "stack") {
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: PullRequestGlyph.stack,
      toneClassName: aggregate.toneClassName,
      label: stackBadgeLabel(
        badge.state,
        badge.layers,
        changeRequestTermKind(terminology),
        resolve,
      ),
      text: badge.layers,
    };
  }
  if (number === undefined || url === undefined) return null;

  const tooltip =
    status?.tooltip ??
    resolve(
      msg("{term, select, mr {MR} cr {change request} other {PR}} #{number}, status pending", {
        term: changeRequestTermKind(terminology),
        number,
      }),
    );
  if (badge?.kind === "pull-request" && badge.others > 0) {
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: aggregate.Icon,
      toneClassName: aggregate.toneClassName,
      label: moreLinkedBadgeLabel(badge.state, tooltip, badge.others, resolve),
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

export function ThreadPullRequestBadgeControl({
  render,
  badge,
  pullRequests,
  number,
  url,
  status,
  onOpenList,
  onOpenPullRequest,
  side,
}: {
  render: ReactElement<{ render?: useRender.RenderProp }>;
  badge: ThreadPullRequestBadge | null;
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  number?: number | undefined;
  url?: string | undefined;
  status: PrStatusIndicator | null;
  onOpenList: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, url?: string) => void;
  side?: ThreadLinkBadgeSide | undefined;
}) {
  const m = useMessages();
  const presentation = resolveThreadPullRequestBadgePresentation({ badge, number, url, status }, m);
  if (presentation === null) return null;
  return (
    <PullRequestBadge
      render={render}
      presentation={presentation}
      opensList={badge !== null && (badge.kind === "stack" || badge.others > 0)}
      url={url}
      number={number}
      status={status}
      pullRequests={pullRequests}
      onOpenList={onOpenList}
      onOpenPullRequest={onOpenPullRequest}
      side={side}
    />
  );
}

function PullRequestBadge({
  render,
  presentation,
  opensList,
  url,
  number,
  status,
  pullRequests,
  onOpenList,
  onOpenPullRequest,
  side,
}: {
  render: ReactElement<{ render?: useRender.RenderProp }>;
  presentation: NonNullable<ReturnType<typeof resolveThreadPullRequestBadgePresentation>>;
  opensList: boolean;
  url: string | undefined;
  number: number | undefined;
  status: PrStatusIndicator | null;
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  onOpenList: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, url?: string) => void;
  side: ThreadLinkBadgeSide | undefined;
}) {
  const onClick = opensList
    ? (event: MouseEvent<HTMLElement>) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenList();
      }
    : onOpenPullRequest;
  const element = opensList ? (
    <button type="button" />
  ) : (
    <a href={url} target="_blank" rel="noopener noreferrer" />
  );
  const control = useRender({
    render,
    props: {
      render: element,
      "aria-label": presentation.label,
      onPointerDown: (event: MouseEvent<HTMLElement>) => event.stopPropagation(),
      onClick,
    },
  });
  return (
    <ThreadLinkBadge
      key={opensList ? "list" : "link"}
      control={control}
      Icon={presentation.Icon}
      toneClassName={presentation.toneClassName}
      text={presentation.text}
      side={side}
    >
      {visibleThreadPullRequests(pullRequests).length > 0 ? (
        <ThreadPullRequestsMiniList
          pullRequests={pullRequests}
          onOpenPullRequest={onOpenPullRequest}
          onShowAll={onOpenList}
        />
      ) : number !== undefined && url !== undefined ? (
        <ul className="flex flex-col gap-1">
          <ThreadPullRequestMiniListItem
            number={number}
            url={url}
            title={status?.tooltipTitle ?? presentation.label}
            presentation={presentation}
            onOpenPullRequest={onOpenPullRequest}
          />
        </ul>
      ) : null}
    </ThreadLinkBadge>
  );
}

type ThreadLinkBadgeSide = "top" | "right";

export function ThreadLinkBadge({
  control,
  Icon,
  toneClassName,
  text,
  side = "top",
  children,
}: {
  control: ReactElement;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  toneClassName: string;
  text: string | number;
  side?: ThreadLinkBadgeSide | undefined;
  children: ReactNode;
}) {
  return (
    // The shared popup renders at the app root, so a right-click in it never reaches the row.
    <SharedTooltipTrigger
      render={control}
      side={side}
      {...(side === "right" ? { align: "start" as const } : {})}
      sideOffset={0}
      variant="glass"
      className="w-80 max-w-[calc(100vw-2rem)] text-left whitespace-normal"
      label={
        <div className="-mx-1 max-h-[calc(var(--available-height)-0.5rem-2px)] overflow-y-auto overscroll-contain">
          {children}
        </div>
      }
    >
      <span className={cn("contents font-normal text-xs tabular-nums", toneClassName)}>
        <Icon aria-hidden className="size-3 shrink-0" />
        <span className="max-w-16 truncate">{text}</span>
      </span>
    </SharedTooltipTrigger>
  );
}

// Hover previews stay short: rendering hundreds of rows froze the page and
// filled the screen. The full list lives in the Linked items tab.
export const LINKED_ITEMS_PREVIEW_LIMIT = 8;

export function LinkedItemsOverflow({
  hidden,
  onShowAll,
}: {
  hidden: number;
  onShowAll?: (() => void) | undefined;
}) {
  if (hidden <= 0) return null;
  if (!onShowAll) {
    return (
      <div className="px-1 pt-1 text-muted-foreground">
        <T>
          +<Var>{hidden}</Var> more
        </T>
      </div>
    );
  }
  return (
    <Button
      variant="ghost-muted"
      size="xs"
      className="mt-1 w-full justify-start"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onShowAll();
      }}
    >
      <T>
        +<Var>{hidden}</Var> more in Linked items
      </T>
    </Button>
  );
}

export function ThreadPullRequestsMiniList({
  pullRequests,
  onOpenPullRequest,
  onShowAll,
}: {
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  onOpenPullRequest?: (event: MouseEvent<HTMLAnchorElement>, url: string) => void;
  onShowAll?: (() => void) | undefined;
}) {
  const lines = pipe(
    visibleThreadPullRequests(pullRequests),
    resolveThreadPullRequestChains,
    pullRequestListLines,
  );
  if (lines.length === 0) return null;
  return (
    <>
      <ul className="flex flex-col gap-1">
        {lines.slice(0, LINKED_ITEMS_PREVIEW_LIMIT).map((line) => {
          const snapshot = line.link.snapshot;
          const presentation =
            snapshot === null
              ? null
              : resolvePullRequestState({ state: snapshot.state, isDraft: snapshot.isDraft });
          return (
            <ThreadPullRequestMiniListItem
              key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
              number={line.link.number}
              url={line.link.url}
              title={snapshot?.title ?? line.link.repository}
              presentation={presentation}
              depth={line.depth}
              onOpenPullRequest={onOpenPullRequest}
            >
              {line.stack ? (
                <span className="ml-auto shrink-0 pl-1 text-3xs">
                  {line.stack.kind === "native" ? (
                    <T context="a native stack of pull requests">stack</T>
                  ) : (
                    <T context="a chain of pull requests based on each other">chain</T>
                  )}{" "}
                  · {line.stack.size}
                </span>
              ) : null}
            </ThreadPullRequestMiniListItem>
          );
        })}
      </ul>
      <LinkedItemsOverflow
        hidden={lines.length - LINKED_ITEMS_PREVIEW_LIMIT}
        onShowAll={onShowAll}
      />
    </>
  );
}

function ThreadPullRequestMiniListItem({
  number,
  url,
  title,
  presentation,
  depth = 0,
  onOpenPullRequest,
  children,
}: {
  number: number;
  url: string;
  title: string;
  presentation: Pick<ThreadPullRequestBadgePresentation, "Icon" | "toneClassName"> | null;
  depth?: number;
  onOpenPullRequest?: ((event: MouseEvent<HTMLAnchorElement>, url: string) => void) | undefined;
  children?: ReactNode;
}) {
  const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
  const content = (
    <>
      <Icon
        aria-hidden
        className={cn("size-3 shrink-0", presentation?.toneClassName ?? "stroke-muted-foreground")}
      />
      <span className="shrink-0 font-mono tabular-nums">#{number}</span>
      <span className="min-w-0 truncate text-foreground/75">{title}</span>
      {children}
    </>
  );
  return (
    <li style={{ paddingLeft: `${Math.min(depth, 3) * 0.75}rem` }}>
      {onOpenPullRequest ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => onOpenPullRequest(event, url)}
        >
          {content}
        </a>
      ) : (
        <div className="flex min-w-0 items-center gap-2">{content}</div>
      )}
    </li>
  );
}

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
  resolve: MessageResolver = m,
): PrStatusIndicator | null {
  if (!pr) return null;
  const term = changeRequestTermKind(sourceControlClients.get(provider?.kind).changeRequest);
  const state = resolvePullRequestState({ state: pr.state, isDraft: pr.isDraft === true }, resolve);
  const { label, tooltipLead } = prStatusLabels(
    pr.state === "open" && pr.isDraft === true ? "draft" : pr.state,
    term,
    pr.number,
    resolve,
  );
  return {
    label,
    colorClass: state.toneClassName,
    Icon: state.Icon,
    tooltip: resolve(msg("{tooltipLead}: {title}", { tooltipLead, title: pr.title })),
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

function PrStatusTooltipContent({ status }: { status: PrStatusIndicator }) {
  return (
    <span className="flex max-w-[min(34rem,calc(100vw-2rem))] items-stretch overflow-hidden whitespace-nowrap">
      <span className="shrink-0 pr-2 font-medium">{status.tooltipLead}</span>
      <span className="min-h-4 shrink-0 border-border/70 border-l" aria-hidden="true" />
      <span className="min-w-0 truncate pl-2">{status.tooltipTitle}</span>
    </span>
  );
}

export function resolveDisplayedThreadPr(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): ThreadPr | null {
  const { threadBranch, gitStatus, linkedPullRequest, linkedPullRequestStatus } = input;
  if (linkedPullRequest != null) {
    return linkedPullRequestStatus?.pr ?? null;
  }
  if (
    threadBranch !== null &&
    gitStatus !== null &&
    gitStatus.refName === threadBranch &&
    gitStatus.pr?.state === "open"
  ) {
    return gitStatus.pr;
  }

  return null;
}

export function resolveDisplayedThreadPrProvider(input: {
  threadBranch: string | null;
  gitStatus: VcsStatusResult | null;
  linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  linkedPullRequestStatus?: LinkedThreadPullRequestStatus | null | undefined;
}): VcsStatusResult["sourceControlProvider"] | undefined {
  const { gitStatus, linkedPullRequest, linkedPullRequestStatus } = input;
  if (linkedPullRequest != null) {
    return linkedPullRequestStatus?.sourceControlProvider;
  }
  if (resolveDisplayedThreadPr(input) !== null) {
    return gitStatus?.sourceControlProvider;
  }

  return undefined;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: resolve(msg("Terminal process running")),
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

function synchronizeTerminalPulse(event: AnimationEvent<SVGSVGElement>) {
  if (event.animationName !== "status-pulse") return;

  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "status-pulse") {
      animation.startTime = 0;
    }
  }
}

export function ThreadTerminalStatusButton({
  threadRef,
  terminalIds,
  onThreadActivate,
}: {
  threadRef: ScopedThreadRef;
  terminalIds: readonly string[];
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  const terminalId = terminalIds[0];
  if (terminalId === undefined) return null;
  const status = terminalStatusFromRunningIds(terminalIds, messages);
  const label = gt(
    "{count, plural, one {{count} terminal process running. Open terminal} other {{count} terminal processes running. Open terminal}}",
    { count: terminalIds.length },
  );
  return (
    <SharedTooltipTrigger
      render={
        <button
          type="button"
          aria-label={label}
          data-testid={`sidebar-terminal-status-${threadRef.threadId}`}
          className={cn(
            "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-sm outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            status?.colorClass,
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            revealThreadTerminal(threadRef, terminalId);
            onThreadActivate(threadRef);
          }}
        />
      }
      label={label}
    >
      <TerminalIcon
        className="size-3.5 motion-safe:animate-status-pulse"
        onAnimationStart={synchronizeTerminalPulse}
      />
    </SharedTooltipTrigger>
  );
}

function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  const m = useMessages();
  const label = m(status.label);
  if (compact) {
    return (
      <SharedTooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
          />
        }
        label={label}
      >
        <span
          className={`size-[9px] rounded-full ${status.dotClass} ${
            status.pulse ? "motion-safe:animate-status-pulse" : ""
          }`}
        />
      </SharedTooltipTrigger>
    );
  }

  return (
    <SharedTooltipTrigger
      render={
        <span
          role="img"
          aria-label={label}
          className={`inline-flex items-center gap-1 text-3xs ${status.colorClass}`}
        />
      }
      label={label}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
          status.pulse ? "motion-safe:animate-status-pulse" : ""
        }`}
      />
      <span className="hidden md:inline">{label}</span>
    </SharedTooltipTrigger>
  );
}

export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const gt = useGT();
  const m = useMessages();
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(false);
  // A new ref callback would detach and reattach the row, and each reattach sets lease state.
  const statusRef = useStableCallback((node: HTMLSpanElement | null) =>
    rowRef(node?.parentElement ?? null),
  );
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const threadProject = useProject(scopeProjectRef(thread.environmentId, thread.projectId));
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const linkedPullRequest = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    leaseLiveStatus,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus &&
      thread.linkedPullRequest == null &&
      (thread.branch != null || thread.worktreePath !== null) &&
      gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd, includeRemote: false },
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
    linkedPullRequest: thread.linkedPullRequest,
    linkedPullRequestStatus: linkedPullRequest,
  };
  const pr = linkedPullRequest?.pr ?? resolveDisplayedThreadPr(displayedPrInput);
  const prStatus = prStatusIndicator(
    pr,
    linkedPullRequest?.sourceControlProvider ?? resolveDisplayedThreadPrProvider(displayedPrInput),
    m,
  );
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
        <SharedTooltipTrigger
          render={
            <span
              aria-label={prStatus.tooltip}
              className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
            />
          }
          label={
            <>
              <PrStatusTooltipContent status={prStatus} />
            </>
          }
        >
          <ChangeRequestStatusIcon state={pr.state} isDraft={pr.isDraft} className="size-3" />
        </SharedTooltipTrigger>
      ) : null}
      {pendingLink ? (
        <PullRequestGlyph.pullRequest
          className="size-3 text-muted-foreground"
          aria-label={gt(
            "{term, select, mr {MR} cr {change request} other {PR}} #{number}, status pending",
            {
              term: changeRequestTermKind(changeRequestTerminologyForUrl(pendingLink.url)),
              number: pendingLink.number,
            },
          )}
        />
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const gt = useGT();
  const m = useMessages();
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread = thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread
    ? (remoteEnvLabel ?? gt("Remote", { $context: "machine location" }))
    : null;
  const remoteMachine = resolveEnvironmentMachineKind(environment?.serverConfig ?? null);
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds, m);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <SharedTooltipTrigger
          render={
            <span
              role="img"
              aria-label={terminalStatus.label}
              className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
            />
          }
          label={terminalStatus.label}
        >
          <TerminalIcon
            className={`size-3 ${terminalStatus.pulse ? "motion-safe:animate-status-pulse" : ""}`}
            onAnimationStart={synchronizeTerminalPulse}
          />
        </SharedTooltipTrigger>
      ) : null}
      {isRemoteThread ? (
        <SharedTooltipTrigger
          render={
            <span
              aria-label={threadEnvironmentLabel ?? gt("Remote", { $context: "machine location" })}
              className="inline-flex items-center justify-center"
            />
          }
          label={threadEnvironmentLabel}
        >
          <EnvironmentMachineIcon
            kind={remoteMachine}
            className="size-3 text-muted-foreground/60"
          />
        </SharedTooltipTrigger>
      ) : null}
    </span>
  );
}

function settledPrHoverColorClass(state: ThreadPullRequestBadge["state"]): string {
  switch (state) {
    case "draft":
      return "group-hover/sidebar-row:text-zinc-500 dark:group-hover/sidebar-row:text-zinc-400/80";
    case "open":
      return "group-hover/sidebar-row:text-emerald-600 dark:group-hover/sidebar-row:text-emerald-300/90";
    case "merged":
      return "group-hover/sidebar-row:text-violet-600 dark:group-hover/sidebar-row:text-violet-300/90";
    case "closed":
      return "group-hover/sidebar-row:text-red-600 dark:group-hover/sidebar-row:text-red-300/90";
  }
}

// Search rows are already buttons, so this renders the sidebar badge's look without its controls.
export function ThreadSearchPullRequestNumber({
  thread,
  query,
  enabled = true,
  settled = false,
}: {
  thread: SidebarThreadSummary;
  query: string;
  enabled?: boolean;
  settled?: boolean;
}) {
  const matched = pullRequestMatchesSearchQuery(thread, query);
  const supportsMultiplePullRequests = useSupportsMultiplePullRequests(thread.environmentId);
  const linked = useLinkedThreadPullRequest(
    thread.environmentId,
    thread.linkedPullRequest,
    enabled && matched,
    thread.pullRequests,
    thread.branchPullRequest,
  );
  const m = useMessages();
  if (!matched) return null;
  const badge = supportsMultiplePullRequests
    ? resolveThreadPullRequestBadge(thread.pullRequests)
    : null;
  const current = supportsMultiplePullRequests
    ? resolveThreadCurrentPullRequestLink(thread.pullRequests)
    : null;
  const pr = linked?.pr ?? null;
  // Stored references already carry a number, so the badge shows before PR details load.
  const stored =
    current ??
    [thread.linkedPullRequest, thread.branchPullRequest].find(
      (reference) =>
        reference != null && pullRequestMatchesSearchQuery({ linkedPullRequest: reference }, query),
    );
  const presentation = resolveThreadPullRequestBadgePresentation(
    {
      badge,
      number: pr?.number ?? stored?.number,
      url: pr?.url ?? stored?.url,
      status: prStatusIndicator(pr, linked?.sourceControlProvider, m),
    },
    m,
  );
  if (presentation === null) return null;
  const aggregate = badge !== null && (badge.kind === "stack" || badge.others > 0);
  const state = aggregate
    ? badge.state
    : pr === null
      ? null
      : pr.state === "open" && pr.isDraft
        ? "draft"
        : pr.state;
  return (
    <span
      aria-label={presentation.label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-xs tabular-nums",
        settled
          ? cn("text-secondary-label transition-colors", state && settledPrHoverColorClass(state))
          : presentation.toneClassName,
      )}
    >
      {/* text-current opts out of the command palette's muted icon color. */}
      <presentation.Icon aria-hidden className="size-3 shrink-0 text-current" />
      <span>{presentation.text}</span>
    </span>
  );
}
