import { pipe } from "effect/Function";
import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useSupportsMultiplePullRequests } from "~/hooks/useSupportsMultiplePullRequests";
import { useStableCallback } from "~/hooks/useStableCallback";

import { pullRequestDetailToVcsStatus } from "@t3tools/client-runtime/state/pull-requests";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { FolderGit2Icon, TerminalIcon } from "lucide-react";
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
import { type ReactNode, type AnimationEvent, type MouseEvent, type ReactElement } from "react";
import { cn } from "../lib/utils";
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
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  PULL_REQUEST_STATE_PRESENTATION,
  PullRequestGlyph,
  type PullRequestGlyphIcon,
} from "./pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";
import type { LinkedThreadPullRequestStatus, PrStatusIndicator } from "./ThreadStatusIndicators.tsx";
import { PullRequestBadge } from "./ThreadStatusIndicators.tsx";

export function linkedPullRequestReference(fallback: ThreadLinkedPullRequest) {
  const host = sourceControlClients.parseChangeRequestUrl(fallback.url)?.link.host;
  return { ...fallback, ...(host === undefined ? {} : { host }) };
}

export function changeRequestTerminologyForUrl(url: string | undefined) {
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
  const terminology = changeRequestTerminologyForUrl(url);
  if (badge?.kind === "stack") {
    const aggregate = PULL_REQUEST_STATE_PRESENTATION[badge.state];
    return {
      Icon: PullRequestGlyph.stack,
      toneClassName: aggregate.toneClassName,
      label: `Stack of ${badge.layers} ${terminology.plural}, ${aggregate.label.toLowerCase()}`,
      text: badge.layers,
    };
  }
  if (number === undefined || url === undefined) return null;

  const tooltip = status?.tooltip ?? `${terminology.shortLabel} #${number}, status pending`;
  if (badge?.kind === "pull-request" && badge.others > 0) {
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

export function ThreadPullRequestBadgeControl({
  render,
  badge,
  pullRequests,
  number,
  url,
  status,
  onOpenList,
  onOpenPullRequest,
}: {
  render: ReactElement<{ render?: useRender.RenderProp }>;
  badge: ThreadPullRequestBadge | null;
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  number?: number | undefined;
  url?: string | undefined;
  status: PrStatusIndicator | null;
  onOpenList: () => void;
  onOpenPullRequest: (event: MouseEvent<HTMLElement>, url?: string) => void;
}) {
  const presentation = resolveThreadPullRequestBadgePresentation({ badge, number, url, status });
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
    />
  );
}

