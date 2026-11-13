import { useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { SectionHeaderStatus } from "../ui/collapsible-section-header";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { deriveProviderSubagentStatus } from "@t3tools/client-runtime/state/thread-execution";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  threadRelationshipRowStatus,
  orderWebThreadLineageRows,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
  type ThreadRelationshipWalkRow,
} from "@t3tools/client-runtime/state/thread-relationships";
import {
  canDetachThreadProviderSession,
  resolveLatestMergeBackRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  NodeId,
  type EnvironmentId,
  type OrchestrationV2DelegatedFrom,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { groupBy } from "effect/Array";
import * as DateTime from "effect/DateTime";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  ChevronDownIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  SquareIcon,
  UnplugIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  useProjects,
  useQuietThreadShell,
  useThreadProjection,
  useThreadRelationshipShells,
  useHiddenThreadKeys,
  useAnyEnvironmentHiding,
} from "../../state/entities";
import { useEnvironment, useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { threadEnvironment } from "../../state/threads";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { ThreadLineageWorkflowRow } from "./ThreadLineageWorkflowRow";
import { openSideChatTab } from "../../lib/sideChatPane";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

const THREAD_LINEAGE_INITIAL_COUNT = 6;
const THREAD_LINEAGE_PAGE_COUNT = 12;

function resolveThreadLineageWindow<Row>(
  rows: ReadonlyArray<Row>,
  visibleCount: number,
): { readonly visibleRows: ReadonlyArray<Row>; readonly hiddenCount: number } {
  const visibleRows = rows.slice(0, visibleCount);
  return { visibleRows, hiddenCount: rows.length - visibleRows.length };
}

export function ThreadLineageRowList(props: {
  readonly hiddenCount: number;
  readonly onShowMore: () => void;
  readonly children: ReactNode;
}) {
  return (
    <>
      {/* ScrollArea's max-height viewport measures badly inside this scrolling panel. */}
      <ul
        aria-label="Related threads"
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto overscroll-contain p-0 has-data-workflow-expanded:max-h-[min(28rem,55dvh)]"
      >
        {props.children}
      </ul>
      {props.hiddenCount > 0 ? (
        <button
          type="button"
          onClick={props.onShowMore}
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-sm font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]`}
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          Show {Math.min(props.hiddenCount, THREAD_LINEAGE_PAGE_COUNT)} more
        </button>
      ) : null}
    </>
  );
}

export function ThreadLineageGroup(props: {
  readonly label: string | null;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly expanded: boolean;
  readonly children: (rows: ReadonlyArray<ThreadRelationshipWalkRow>) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.expanded);
  const [visibleCount, setVisibleCount] = useState(THREAD_LINEAGE_INITIAL_COUNT);
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(props.rows, visibleCount);
  const failedCount = props.rows.filter(
    ({ edge }) => edge.status === "failed" || edge.status === "error",
  ).length;
  if (props.rows.length === 0) return null;
  return (
    <div>
      {props.label ? (
        <ThreadDetailsControl aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <BotIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
            {props.label}
          </span>
          {failedCount > 0 ? <SectionHeaderStatus>{failedCount} failed</SectionHeaderStatus> : null}
          {expanded ? null : (
            <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
              {props.rows.length}
            </span>
          )}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              THREAD_DETAILS_PANEL_CHEVRON_CLASS,
              "transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </ThreadDetailsControl>
      ) : null}
      {expanded ? (
        <ThreadLineageRowList
          hiddenCount={hiddenCount}
          onShowMore={() => setVisibleCount((count) => count + THREAD_LINEAGE_PAGE_COUNT)}
        >
          {props.children(visibleRows)}
        </ThreadLineageRowList>
      ) : null}
    </div>
  );
}

export function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId) {
  if (edge.kind === "transfer") return "Context transfer";
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Parent thread";
}

export function relationshipThreadTitle(input: {
  readonly title: string;
  readonly isSubagent: boolean;
}): string {
  if (!input.isSubagent) return input.title;
  return formatSubagentDisplayTitle(input.title);
}

/** The full title, since the row truncates it, with what a click does. */
export function LineageTooltipContent(props: { readonly title: string; readonly hint: string }) {
  return (
    <>
      <span className="block font-medium">{props.title}</span>
      <span className="block text-muted-foreground">{props.hint}</span>
    </>
  );
}

export function currentSubagent<Agent extends RuntimeSubagent>(
  agent: Agent | undefined,
  childThread: OrchestrationV2ThreadShell | null | undefined,
): Agent | undefined {
  if (!agent || !childThread || isOrchestrationV2WorkActive(agent.status)) return agent;
  const liveStatus =
    childThread.activityRunStatus ?? (childThread.status === "queued" ? "queued" : null);
  const newerRun =
    childThread.latestRunRequestedAt &&
    DateTime.toEpochMillis(childThread.latestRunRequestedAt) >
      Date.parse(agent.completedAt ?? agent.startedAt ?? agent.updatedAt);
  if (!liveStatus && !newerRun) return agent;
  const status = liveStatus ?? childThread.status;
  const startedAt = liveStatus ? childThread.activityRunStartedAt : childThread.latestRunStartedAt;
  const completedAt = liveStatus ? null : childThread.latestRunCompletedAt;
  return {
    ...agent,
    status:
      status === "preparing" || status === "starting" || status === "queued"
        ? "pending"
        : status === "rolled_back"
          ? "interrupted"
          : status,
    startedAt: startedAt ? DateTime.formatIso(startedAt) : null,
    completedAt: completedAt ? DateTime.formatIso(completedAt) : null,
    progress: null,
    result: null,
    error: null,
  };
}

/**
 * A task delegated to a linked environment. It has no thread here, so it opens
 * the thread there, when this client is connected to that environment.
 */
export function RemoteSubagentRow(props: {
  readonly agent: OrchestrationV2Subagent & {
    readonly remoteChild: OrchestrationV2RemoteTaskChild;
  };
  readonly provider: ServerProvider | undefined;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(props.agent.remoteChild.environmentId);
  const { remoteChild } = props.agent;
  const status = props.agent.status;
  const failed = status === "failed";
  const title = relationshipThreadTitle({
    title: props.agent.title ?? "Subagent",
    isSubagent: true,
  });
  return (
    <li className="group relative flex h-8 items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              aria-disabled={environment === null || undefined}
              onClick={() => {
                if (environment === null) return;
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(
                    scopeThreadRef(remoteChild.environmentId, remoteChild.threadId),
                  ),
                });
              }}
            />
          }
        >
          <ThreadRelationshipIcon
            // The task's own driver here is only a "remote" label.
            driver={props.provider?.driver}
            provider={props.provider}
            fallbackIcon={BotIcon}
            status={status}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
              {title}
            </span>
          </span>
          <span
            className={`shrink-0 text-2xs ${failed ? "text-destructive" : "text-muted-foreground"}`}
          >
            on {remoteChild.label} · {threadRelationshipStatusLabel(status)}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">
          <LineageTooltipContent
            title={title}
            hint={
              environment === null
                ? `Runs on ${remoteChild.label}. Connect to it to open the thread there.`
                : `Open on ${remoteChild.label}`
            }
          />
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

/**
 * The thread on a linked environment whose agent delegated this one. It opens
 * there when this client is connected to that environment.
 */
export function DelegatedFromRow(props: {
  readonly delegatedFrom: OrchestrationV2DelegatedFrom;
  readonly fallbackLabel: string | undefined;
}) {
  const navigate = useNavigate();
  const { delegatedFrom } = props;
  const environment = useEnvironment(delegatedFrom.environmentId);
  const parentRef = scopeThreadRef(delegatedFrom.environmentId, delegatedFrom.threadId);
  // The title it had at delegation, until this client sees the parent itself.
  const parent = useQuietThreadShell(parentRef);
  const label = environment?.label ?? props.fallbackLabel;
  const title = parent?.title ?? delegatedFrom.title;
  return (
    <li className="group relative flex h-8 items-center rounded-lg">
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              aria-disabled={environment === null || undefined}
              onClick={() => {
                if (environment === null) return;
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(parentRef),
                });
              }}
            />
          }
        >
          <ThreadRelationshipIcon fallbackIcon={CornerLeftUpIcon} status={null} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
              {title}
            </span>
          </span>
          {label ? (
            <span className="shrink-0 text-2xs text-muted-foreground">on {label}</span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left">
          <LineageTooltipContent
            title={title}
            hint={
              environment === null
                ? `Delegated from ${label ?? "a linked environment"}. Connect to it to open the parent thread.`
                : "Open parent agent"
            }
          />
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}
export * from "./ThreadRelationshipsControlParts";
