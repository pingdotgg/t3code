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
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import {
  isOrchestrationV2WorkActive,
  isProviderNativeSubagentThread,
  NodeId,
  type EnvironmentId,
  type OrchestrationV2DelegatedFrom,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import { groupBy } from "effect/Array";
import * as DateTime from "effect/DateTime";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  ChevronDownIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  MessagesSquareIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState, type ReactNode } from "react";
import type { MessageResolver } from "~/i18n/messages";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import { useLinkedThreadOpener } from "../../state/linkedThreadView";
import {
  useProjects,
  useQuietThreadProjection,
  useQuietThreadShell,
  useThreadRelationshipShells,
  useHiddenThreadKeys,
  useAnyEnvironmentHiding,
} from "../../state/entities";
import { useEnvironment, useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  hasInstanceBadge,
} from "../../providerInstances";
import { threadEnvironment } from "../../state/threads";
import { orchestrationEnvironment, threadTitlesRead } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { ThreadLineageWorkflowRow } from "./ThreadLineageWorkflowRow";
import { useSideThreadTrigger } from "../../hooks/useSideThreadTrigger";
import { openSideThread, resolveThreadOpenRoute } from "../../lib/sideChatPane";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
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

function ThreadLineageRowList(props: {
  readonly hiddenCount: number;
  readonly onShowMore: () => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const listRef = useRef<HTMLUListElement>(null);
  const showMore = () => {
    const exhausting = props.hiddenCount <= THREAD_LINEAGE_PAGE_COUNT;
    props.onShowMore();
    // The button unmounts on the final page; focus the list so focus isn't dropped.
    if (exhausting) listRef.current?.focus({ preventScroll: true });
  };
  return (
    <>
      {/* ScrollArea's max-height viewport measures badly inside this scrolling panel. */}
      <ul
        ref={listRef}
        tabIndex={-1}
        aria-label={gt("Related threads")}
        className="m-0 max-h-[13.5rem] list-none overflow-y-auto p-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70 has-data-workflow-expanded:max-h-[min(28rem,55dvh)]"
      >
        {props.children}
      </ul>
      {props.hiddenCount > 0 ? (
        <button
          type="button"
          onClick={showMore}
          className={`flex h-8 w-full cursor-pointer items-center rounded-lg ${THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS} text-sm font-medium text-muted-foreground/70 hover:bg-black/[0.055] hover:text-foreground/80 dark:hover:bg-white/[0.075]`}
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          <T>
            Show <Var>{Math.min(props.hiddenCount, THREAD_LINEAGE_PAGE_COUNT)}</Var> more
          </T>
        </button>
      ) : null}
    </>
  );
}

type RemoteSubagent = OrchestrationV2Subagent & {
  readonly remoteChild: OrchestrationV2RemoteTaskChild;
};

/** A task delegated to a linked environment has no thread here, so it gets its own row kind. */
type LineageRow = ThreadRelationshipWalkRow | { readonly remote: RemoteSubagent };

const lineageRowStatus = (row: LineageRow) =>
  "remote" in row ? row.remote.status : row.edge.status;

const isFinishedAgentStatus = (status: string | null | undefined) =>
  ["completed", "failed", "error", "cancelled", "interrupted", "idle"].includes(status ?? "");

function ThreadLineageGroup<Row extends LineageRow>(props: {
  readonly label: string | null;
  readonly rows: ReadonlyArray<Row>;
  readonly expanded: boolean;
  readonly children: (rows: ReadonlyArray<Row>) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.expanded);
  const [visibleCount, setVisibleCount] = useState(THREAD_LINEAGE_INITIAL_COUNT);
  const { visibleRows, hiddenCount } = resolveThreadLineageWindow(props.rows, visibleCount);
  const failedCount = props.rows.filter((row) => {
    const status = lineageRowStatus(row);
    return status === "failed" || status === "error";
  }).length;
  if (props.rows.length === 0) return null;
  return (
    <div>
      {props.label ? (
        <ThreadDetailsControl aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <BotIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
            {props.label}
          </span>
          {failedCount > 0 ? (
            <SectionHeaderStatus>
              <T>
                <Var>{failedCount}</Var> failed
              </T>
            </SectionHeaderStatus>
          ) : null}
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

function relationshipHint(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
  sideChat: boolean,
  resolve: MessageResolver,
) {
  if (sideChat) return resolve(msg("Open side chat"));
  if (edge.kind === "transfer") return resolve(msg("Open context transfer in this chat"));
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId
      ? resolve(msg("Open subagent"))
      : resolve(msg("Open parent agent in this chat"));
  }
  return edge.sourceThreadId === currentThreadId
    ? resolve(msg("Open fork in this chat"))
    : resolve(msg("Open parent thread in this chat"));
}

function relationshipThreadTitle(input: {
  readonly title: string;
  readonly isSubagent: boolean;
}): string {
  if (!input.isSubagent) return input.title;
  return formatSubagentDisplayTitle(input.title);
}

/** The full title, since the row truncates it, with what a click does. */
function LineageTooltipContent(props: { readonly title: string; readonly hint: string }) {
  return (
    <>
      <span className="block font-medium">{props.title}</span>
      <span className="block text-muted-foreground">{props.hint}</span>
    </>
  );
}

function currentSubagent<Agent extends RuntimeSubagent>(
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
 * A task delegated to a linked environment. It has no thread here, so it opens the thread there:
 * in place when this client is connected to that environment, else read-only through this one.
 */
function RemoteSubagentRow(props: {
  readonly agent: RemoteSubagent;
  /** The thread that delegated the task; its environment holds the link and its panel shows the read. */
  readonly parentRef: ScopedThreadRef;
  readonly provider: ServerProvider | undefined;
  readonly anyInstanceBadge: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const { remoteChild } = props.agent;
  const status = props.agent.status;
  const failed = status === "failed";
  const timing = {
    status,
    startedAt: props.agent.startedAt ? DateTime.formatIso(props.agent.startedAt) : null,
    completedAt: props.agent.completedAt ? DateTime.formatIso(props.agent.completedAt) : null,
  };
  const showElapsed = !failed && deriveSubagentElapsedMs(timing, 0) !== null;
  const title = relationshipThreadTitle({
    title: props.agent.title ?? gt("Subagent"),
    isSubagent: true,
  });
  const opener = useLinkedThreadOpener(props.parentRef, remoteChild, title);
  const trigger = useSideThreadTrigger();
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
              {...(opener ? trigger(opener.open, { panel: opener.mode === "linked" }) : {})}
            />
          }
        >
          <ThreadRelationshipIcon
            // The task's own driver here is only a "remote" label.
            driver={props.provider?.driver}
            provider={props.provider}
            anyInstanceBadge={props.anyInstanceBadge}
            fallbackIcon={BotIcon}
            status={status}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
              {title}
            </span>
          </span>
          <span
            className={`flex max-w-1/2 shrink-0 gap-1 text-2xs ${failed ? "text-destructive" : "text-muted-foreground"}`}
          >
            <span className="truncate">
              <T>
                on <Var>{remoteChild.label}</Var>
              </T>
            </span>
            <span className="shrink-0 tabular-nums">
              ·{" "}
              {showElapsed ? (
                <AgentElapsed agent={timing} compact />
              ) : (
                threadRelationshipStatusLabel(status, m)
              )}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left">
          <LineageTooltipContent
            title={title}
            hint={
              opener?.mode === "linked"
                ? gt("Read the thread on {label}", { label: remoteChild.label })
                : gt("Open on {label}", { label: remoteChild.label })
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
function DelegatedFromRow(props: {
  readonly delegatedFrom: OrchestrationV2DelegatedFrom;
  readonly fallbackLabel: string | undefined;
  readonly anyInstanceBadge: boolean;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const router = useRouter();
  const { delegatedFrom } = props;
  const environment = useEnvironment(delegatedFrom.environmentId);
  const parentRef = scopeThreadRef(delegatedFrom.environmentId, delegatedFrom.threadId);
  // The title it had at delegation, until this client sees the parent itself.
  const parent = useQuietThreadShell(parentRef);
  const readParent = useAtomCommand(threadTitlesRead);
  const [opening, setOpening] = useState(false);
  const label = environment?.label ?? props.fallbackLabel;
  const title = parent?.title ?? delegatedFrom.title;
  // The parent may have been deleted there since delegation, and the shell can't
  // tell a deleted parent from one this client never loaded, so ask its environment.
  const openParent = async () => {
    if (opening) return;
    setOpening(true);
    const location = router.latestLocation;
    const result = await readParent({
      environmentId: delegatedFrom.environmentId,
      input: { threadIds: [delegatedFrom.threadId] },
    });
    setOpening(false);
    // The read can outlast the user's stay on this thread; a late answer must not pull them back.
    if (router.latestLocation !== location) return;
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: gt("Could not open the parent thread") });
      return;
    }
    // Deleted and unknown threads are absent from the titles.
    if (result.value[delegatedFrom.threadId] === undefined) {
      toastManager.add({ type: "info", title: gt("The parent thread was deleted") });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(parentRef),
    });
  };
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
                void openParent();
              }}
            />
          }
        >
          <ThreadRelationshipIcon
            anyInstanceBadge={props.anyInstanceBadge}
            fallbackIcon={CornerLeftUpIcon}
            status={null}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
              {title}
            </span>
          </span>
          {label ? (
            <span className="max-w-1/2 shrink-0 truncate text-2xs text-muted-foreground">
              <T>
                on <Var>{label}</Var>
              </T>
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="left">
          <LineageTooltipContent
            title={title}
            hint={
              environment === null
                ? label
                  ? gt("Delegated from {label}. Connect to it to open the parent thread.", {
                      label,
                    })
                  : gt(
                      "Delegated from a linked environment. Connect to it to open the parent thread.",
                    )
                : gt("Open parent agent on {label}", { label: environment.label })
            }
          />
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

export function ThreadRelationshipsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly showLineage: boolean;
  readonly showSideChats: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useQuietThreadProjection(ref)?.projection ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const relationshipShells = useThreadRelationshipShells(ref);
  const hiddenKeys = useHiddenThreadKeys();
  const hidingAnywhere = useAnyEnvironmentHiding();
  const allProjects = useProjects();
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedShells = archived.snapshots.find(
    (entry) => entry.environmentId === props.environmentId,
  )?.snapshot.threads;
  const currentThread =
    projection?.thread ??
    relationshipShells.find((thread) => thread.id === props.threadId) ??
    archivedShells?.find((thread) => thread.id === props.threadId);
  const parentThreadId =
    currentThread?.forkedFrom?.type === "run"
      ? currentThread.forkedFrom.threadId
      : currentThread?.lineage.parentThreadId;
  const parentShell = parentThreadId
    ? (relationshipShells.find((thread) => thread.id === parentThreadId) ??
      archivedShells?.find((thread) => thread.id === parentThreadId))
    : undefined;
  const parentRef =
    parentShell && isProviderNativeSubagentThread(parentShell)
      ? scopeThreadRef(props.environmentId, parentShell.id)
      : null;
  const parentProjection = useQuietThreadProjection(parentRef)?.projection;
  const navigate = useNavigate();
  const trigger = useSideThreadTrigger();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const stopWorkflowCommand = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const canOperateWorkflow = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.environmentId),
  );
  const [busyAction, setBusyAction] = useState<"merge" | null>(null);
  const mergeErrorToastId = useRef<string | null>(null);
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  // Derive graphs after hooks to preserve their compiler cache.
  const providers = providersByEnvironment.get(props.environmentId);
  const derivedProviderEntries = deriveProviderInstanceEntries(providers ?? []);
  const providerEntries = settings
    ? applyProviderInstanceSettings(
        derivedProviderEntries,
        settings,
        currentThread?.projectId ?? null,
      )
    : derivedProviderEntries;
  const projects = allProjects.filter((project) => project.environmentId === props.environmentId);
  const parentNativeStatus = parentProjection
    ? deriveProviderSubagentStatus(parentProjection)?.status
    : undefined;
  const projected = projection?.subagents ?? [];
  const runtimeSubagents = projectedSubagentsToRuntime(projected);
  const byId = new Map(runtimeSubagents.map((agent) => [agent.id, agent]));
  const subagentsByThreadId = new Map(
    projected
      .filter((subagent) => subagent.childThreadId !== null)
      .map((subagent) => [
        subagent.childThreadId,
        {
          ...byId.get(subagent.id)!,
          id: subagent.id,
          threadId: subagent.threadId,
          runId: subagent.runId,
          nativeTaskRef: subagent.nativeTaskRef,
          nativeStatus: subagent.status,
          driver: subagent.driver,
          providerInstanceId: subagent.providerInstanceId,
          origin: subagent.origin,
          modelSelection: subagent.modelSelection,
        },
      ]),
  );
  const workflowGroupsById = new Map(
    deriveWorkflowGroups(runtimeSubagents, m).map((group) => [group.workflow.id, group]),
  );
  const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
    ...relationshipShells,
    ...(archivedShells ?? []),
  ];
  const graph = deriveThreadRelationshipGraph({ threads: shells, projection });
  const isHiddenRelation = (threadId: ThreadId) =>
    hiddenKeys.has(threadKey({ environmentId: props.environmentId, threadId }));
  // While hiding, an unloaded parent, fork or transfer may be hidden; unloaded subagent
  // children (idle, left out of the shell) follow this visible thread, so they stay.
  const isHiddenUnloadedRelation = (row: { threadId: ThreadId; edge: ThreadRelationshipEdge }) =>
    hidingAnywhere &&
    graph.nodes.get(row.threadId)?.missing === true &&
    (row.edge.kind !== "subagent" || isParentThreadRelationship(row.edge, props.threadId));
  const currentProject = projects.find((project) => project.id === currentThread?.projectId);
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, props.threadId),
    currentThreadId: props.threadId,
    mergeTargetThreadId,
  })
    // The graph rebuilds missing parents from lineage, so filter the rows it returns.
    .filter((row) => !isHiddenRelation(row.threadId) && !isHiddenUnloadedRelation(row))
    .map((row) => {
      const agent =
        row.edge.kind === "subagent" && !isParentThreadRelationship(row.edge, props.threadId)
          ? subagentsByThreadId.get(row.threadId)
          : undefined;
      const workflowGroup = agent === undefined ? undefined : workflowGroupsById.get(agent.id);
      return workflowGroup === undefined
        ? row
        : { ...row, edge: { ...row.edge, status: workflowGroup.workflow.status } };
    });
  const canMerge = mergeTargetThreadId !== null && latestMergeBackRun !== null;
  const unlistedThreadIds = relationshipRows
    .filter(
      ({ threadId, edge }) =>
        !relationshipShells.some((thread) => thread.id === threadId) &&
        (edge.kind !== "subagent" || !subagentsByThreadId.get(threadId)?.title),
    )
    .map(({ threadId }) => threadId);
  const threadTitles = useEnvironmentQuery(
    unlistedThreadIds.length === 0
      ? null
      : orchestrationEnvironment.threadTitles({
          environmentId: props.environmentId,
          input: { threadIds: unlistedThreadIds },
        }),
  );
  const resolvedThreadTitles = threadTitles.data ?? {};
  // Omitted and archived threads remain reachable; only a settled lookup proves one is gone.
  const visibleRelationships = relationshipRows.filter(
    ({ threadId, edge }) =>
      edge.kind === "subagent" ||
      !unlistedThreadIds.includes(threadId) ||
      !threadTitles.isSuccess ||
      threadTitles.isPending ||
      Object.hasOwn(resolvedThreadTitles, threadId),
  );

  const {
    related = [],
    active = [],
    previous = [],
    sideChats = [],
  } = groupBy(visibleRelationships, ({ threadId, edge }) => {
    const isParent = isParentThreadRelationship(edge, props.threadId);
    if (!isParent && graph.nodes.get(threadId)?.thread?.lineage.sideChat === true)
      return "sideChats";
    if (edge.kind !== "subagent" || isParent) return "related";
    return isFinishedAgentStatus(edge.status) ? "previous" : "active";
  });
  const { remoteActive = [], remotePrevious = [] } = groupBy(
    (projection?.subagents ?? [])
      .filter((agent): agent is RemoteSubagent => agent.remoteChild !== undefined)
      .map((remote) => ({ remote })),
    ({ remote }) => (isFinishedAgentStatus(remote.status) ? "remotePrevious" : "remoteActive"),
  );
  const groups: ReadonlyArray<{
    id: string;
    label: string | null;
    rows: ReadonlyArray<LineageRow>;
    expanded: boolean;
  }> = [
    { id: "related", label: null, rows: related, expanded: true },
    { id: "active", label: null, rows: [...active, ...remoteActive], expanded: true },
    {
      id: "previous",
      label: gt("Previous agents"),
      rows: [...previous, ...remotePrevious],
      expanded: false,
    },
  ];
  const runningCount =
    (projection?.subagents.filter(
      (agent) => agent.childThreadId === null && agent.status === "running",
    ).length ?? 0) + active.filter(({ edge }) => edge.status === "running").length;

  // A linked environment's agent may have delegated this thread from there.
  const delegatedFrom = currentThread?.delegatedFrom;

  const lineageVisible =
    props.showLineage &&
    (related.length > 0 ||
      active.length > 0 ||
      previous.length > 0 ||
      runningCount > 0 ||
      remoteActive.length > 0 ||
      remotePrevious.length > 0 ||
      delegatedFrom !== undefined);
  const sideChatsVisible = props.showSideChats && sideChats.length > 0;
  const runningSideChats = sideChats.filter(({ edge }) => edge.status === "running").length;

  if (!lineageVisible && !sideChatsVisible) {
    return null;
  }

  // Idle children can be omitted from the shell; opening one loads its own detail.
  const openThread = (threadId: ThreadId) => {
    const routeRef = resolveThreadOpenRoute(
      scopeThreadRef(props.environmentId, threadId),
      graph.nodes.get(threadId)?.thread ?? null,
    );
    if (routeRef.threadId === ref.threadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(routeRef),
    });
  };

  // A subagent or side chat of this thread opens beside it or in its place, as the click asks.
  const openSideThreadRow = (threadId: ThreadId, intent: SideThreadOpenIntent) => {
    openSideThread({
      threadRef: scopeThreadRef(props.environmentId, threadId),
      panelRef: ref,
      intent,
      navigate: (threadRef) =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        }),
    });
  };

  const merge = async () => {
    if (!latestMergeBackRun || mergeTargetThreadId === null || busyAction !== null) return;
    if (mergeErrorToastId.current !== null) {
      toastManager.close(mergeErrorToastId.current);
      mergeErrorToastId.current = null;
    }
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: mergeTargetThreadId,
        runId: latestMergeBackRun.id,
      },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      mergeErrorToastId.current = toastManager.add({
        type: "error",
        title: gt("Could not merge back"),
      });
      return;
    }
    openThread(mergeTargetThreadId);
  };

  const stopSubagent = async (
    childThreadId: ThreadId,
    agent: Pick<OrchestrationV2Subagent, "id" | "threadId">,
  ) => {
    if (stoppingId !== null) return;
    setStoppingId(childThreadId);
    const result = await interruptTurn({
      environmentId: props.environmentId,
      input: { threadId: agent.threadId, subagentId: agent.id },
    });
    setStoppingId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: gt("Could not stop subagent") });
    }
  };

  const stopWorkflow = async (subagentId: string) => {
    if (stoppingId !== null) return;
    setStoppingId(subagentId);
    const result = await stopWorkflowCommand({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, subagentId: NodeId.make(subagentId) },
    });
    setStoppingId(null);
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: gt("Could not stop workflow") });
    }
  };

  const parentTitle =
    mergeTargetThreadId === null
      ? null
      : isHiddenRelation(mergeTargetThreadId)
        ? null
        : (graph.nodes.get(mergeTargetThreadId)?.thread?.title ?? null);

  const renderRelationshipRow = ({ threadId, edge }: ThreadRelationshipWalkRow) => {
    const node = graph.nodes.get(threadId);
    const isSubagent = edge.kind === "subagent";
    const isMergeTarget = threadId === mergeTargetThreadId;
    const isParent = isParentThreadRelationship(edge, props.threadId);
    const rowStatus =
      (isParent && threadId === parentRef?.threadId
        ? (node?.thread?.activityRunStatus ?? parentNativeStatus)
        : undefined) ?? threadRelationshipRowStatus(graph, { threadId, edge });
    const RelationshipIcon = isParent
      ? CornerLeftUpIcon
      : isSubagent
        ? BotIcon
        : node?.thread?.lineage.sideChat === true
          ? MessagesSquareIcon
          : GitForkIcon;

    const projectedAgent = isSubagent && !isParent ? subagentsByThreadId.get(threadId) : undefined;
    const workflowGroup =
      projectedAgent === undefined ? undefined : workflowGroupsById.get(projectedAgent.id);
    const agent = workflowGroup ? projectedAgent : currentSubagent(projectedAgent, node?.thread);
    const failed = rowStatus === "failed" || rowStatus === "error";
    const canStop =
      agent &&
      (agent.origin === "app_owned" ||
        (agent.origin === "provider_native" &&
          agent.driver === "claudeAgent" &&
          agent.runId != null &&
          agent.nativeTaskRef?.strength === "strong" &&
          agent.nativeTaskRef.nativeId !== null &&
          ["pending", "running", "waiting"].includes(agent.nativeStatus))) &&
      agent.startedAt &&
      ["pending", "running", "waiting"].includes(agent.status);
    const threadTitle = relationshipThreadTitle({
      title:
        workflowGroup?.workflow.workflowName ??
        // Fresher than an archived snapshot's copy.
        (Object.hasOwn(resolvedThreadTitles, threadId)
          ? resolvedThreadTitles[threadId]
          : undefined) ??
        node?.thread?.title ??
        agent?.title ??
        threadId,
      isSubagent,
    });
    const provider = providers?.find(
      (entry) =>
        entry.instanceId === (agent?.providerInstanceId ?? node?.thread?.providerInstanceId),
    );
    const providerDriver = agent?.driver ?? provider?.driver;
    const canStopWorkflow =
      canOperateWorkflow &&
      workflowGroup?.workflow.status === "running" &&
      agent?.origin === "provider_native" &&
      providerDriver === "claudeAgent";
    const trailingVisibilityClass = (workflowGroup ? canStopWorkflow : canStop)
      ? "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0"
      : "";
    const project = projects.find((project) => project.id === node?.thread?.projectId);
    const isSideChat = node?.thread?.lineage.sideChat === true && !isParent;
    const hint = relationshipHint(edge, props.threadId, isSideChat, m);
    const openProps =
      isSideChat || (isSubagent && !isParent)
        ? trigger((intent) => openSideThreadRow(threadId, intent))
        : { onClick: () => openThread(threadId) };
    const RelationshipPopup = agent ? ThreadHoverCardPopup : TooltipPopup;
    const relationshipTooltip = agent ? (
      <SubagentTooltipContent
        title={threadTitle}
        model={agent.model}
        providerInstanceId={agent.providerInstanceId}
        origin={agent.origin}
        modelSelection={agent.modelSelection}
        provider={provider}
        providers={providers}
        driver={providerDriver}
        elapsed={<AgentElapsed agent={agent} />}
        status={agent.status}
        result={agent.result}
        progress={agent.progress}
        parentThread={currentThread ?? undefined}
        childThread={node?.thread ?? undefined}
        parentProject={currentProject}
        childProject={project}
      />
    ) : (
      <LineageTooltipContent title={threadTitle} hint={hint} />
    );
    const relationshipContent = (
      <>
        <ThreadRelationshipIcon
          driver={isSubagent && !isParent ? providerDriver : undefined}
          provider={provider}
          providerEntries={providerEntries}
          fallbackIcon={RelationshipIcon}
          status={rowStatus}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-left text-sm font-medium leading-4 text-foreground/85">
            {threadTitle}
          </span>
        </span>
        {agent ? null : (
          <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        )}
        {agent && !failed && (deriveSubagentElapsedMs(agent, 0) !== null || canStopWorkflow) ? (
          <span
            className={`shrink-0 text-2xs font-normal tabular-nums text-muted-foreground ${canStopWorkflow ? "min-w-6 text-end" : ""} ${trailingVisibilityClass}`}
          >
            <AgentElapsed agent={agent} compact />
          </span>
        ) : !isMergeTarget ? (
          <span
            className={
              workflowGroup
                ? "sr-only"
                : `shrink-0 text-2xs ${failed ? "text-destructive" : "text-muted-foreground"} ${trailingVisibilityClass}`
            }
          >
            {threadRelationshipStatusLabel(rowStatus, m)}
          </span>
        ) : null}
      </>
    );
    const relationshipLink = (
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part={workflowGroup ? "primary" : "row"}
              {...openProps}
            />
          }
        >
          {relationshipContent}
        </TooltipTrigger>
        <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
      </Tooltip>
    );
    if (workflowGroup && agent) {
      return (
        <ThreadLineageWorkflowRow
          key={threadId}
          group={workflowGroup}
          providerInstanceId={agent.providerInstanceId}
          provider={provider}
          providers={providers}
          providerEntries={providerEntries}
          driver={providerDriver}
          onOpenThread={(memberThreadId, intent) =>
            openSideThreadRow(memberThreadId as ThreadId, intent)
          }
          onStop={canStopWorkflow ? () => void stopWorkflow(agent.id) : undefined}
          stopping={stoppingId === agent.id}
          stopDisabled={stoppingId !== null}
          header={relationshipLink}
        />
      );
    }
    return (
      <li key={threadId} className="group relative flex h-8 items-center rounded-lg">
        {isMergeTarget ? (
          <div className={THREAD_DETAILS_PANEL_SPLIT_GROUP_CLASS}>
            <Tooltip>
              <TooltipTrigger
                delay={200}
                render={
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="primary"
                    aria-label={`${threadTitle} ${threadRelationshipStatusLabel(rowStatus, m)}`}
                    onClick={() => openThread(threadId)}
                  />
                }
              >
                {relationshipContent}
              </TooltipTrigger>
              <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
            </Tooltip>
            <span aria-hidden="true" className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS} />
            <SharedTooltipTrigger
              render={
                <ThreadDetailsControl
                  size="sm"
                  variant="ghost"
                  part="secondary"
                  aria-label={
                    parentTitle
                      ? gt("Merge back to {parentTitle}", { parentTitle })
                      : gt("Merge back to source conversation")
                  }
                  aria-disabled={!canMerge || busyAction !== null || undefined}
                  onClick={() => void merge()}
                >
                  {busyAction === "merge" ? (
                    <Spinner size="xs" />
                  ) : (
                    <PullRequestGlyph.merged className="size-3" />
                  )}
                </ThreadDetailsControl>
              }
              label={
                latestMergeBackRun === null
                  ? gt("Complete a run in this fork before merging it back")
                  : parentTitle
                    ? gt("Merge this conversation back into {parentTitle}", { parentTitle })
                    : gt("Merge this conversation back into its source")
              }
              side="left"
            />
            <span className="shrink-0 border border-transparent ps-1 pe-2.5 text-2xs font-medium text-muted-foreground">
              {threadRelationshipStatusLabel(rowStatus, m)}
            </span>
          </div>
        ) : (
          relationshipLink
        )}
        {canStop && agent ? (
          <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
            <SharedTooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  tone="destructive"
                  aria-label={gt("Stop subagent {threadTitle}", { threadTitle })}
                  disabled={stoppingId !== null}
                  onClick={() => void stopSubagent(threadId, agent)}
                />
              }
              label={
                <>
                  <T>Stop subagent</T>
                </>
              }
              side="left"
            >
              {stoppingId === threadId ? (
                <Spinner aria-hidden size="xs" />
              ) : (
                <SquareIcon aria-hidden className="size-3 fill-current" />
              )}
            </SharedTooltipTrigger>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <>
      {lineageVisible ? (
        <ThreadDetailsSection
          headingId="thread-details-lineage-heading"
          title={
            runningCount > 0
              ? gt("Lineage · {runningCount} running", { runningCount })
              : gt("Lineage", { $context: "thread details section: parent and child agents" })
          }
          // A lone "Previous agents" row names itself; the heading returns for status.
          showHeading={
            runningCount > 0 ||
            related.length > 0 ||
            active.length > 0 ||
            remoteActive.length > 0 ||
            delegatedFrom !== undefined
          }
          data-thread-relationships-panel
        >
          {delegatedFrom === undefined ? null : (
            <ThreadLineageRowList hiddenCount={0} onShowMore={() => {}}>
              <DelegatedFromRow
                delegatedFrom={delegatedFrom}
                fallbackLabel={currentThread?.linkOrigin?.label}
                anyInstanceBadge={hasInstanceBadge(providerEntries)}
              />
            </ThreadLineageRowList>
          )}
          {groups.map((group) => (
            <ThreadLineageGroup key={`${scopedThreadKey(ref)}:${group.id}`} {...group}>
              {(visibleRows) =>
                visibleRows.map((row) =>
                  "remote" in row ? (
                    <RemoteSubagentRow
                      key={row.remote.id}
                      agent={row.remote}
                      parentRef={ref}
                      // Its provider instance belongs to the environment it runs in.
                      provider={providersByEnvironment
                        .get(row.remote.remoteChild.environmentId)
                        ?.find((entry) => entry.instanceId === row.remote.providerInstanceId)}
                      anyInstanceBadge={hasInstanceBadge(providerEntries)}
                    />
                  ) : (
                    renderRelationshipRow(row)
                  ),
                )
              }
            </ThreadLineageGroup>
          ))}
        </ThreadDetailsSection>
      ) : null}
      {sideChatsVisible ? (
        <ThreadDetailsSection
          headingId="thread-details-side-chats-heading"
          title={
            runningSideChats > 0
              ? gt("Side chats · {runningSideChats} running", { runningSideChats })
              : gt("Side chats")
          }
          data-thread-side-chats-panel
        >
          <ThreadLineageGroup
            key={`${scopedThreadKey(ref)}:side-chats`}
            label={null}
            rows={sideChats}
            expanded
          >
            {(visibleRows) => visibleRows.map(renderRelationshipRow)}
          </ThreadLineageGroup>
        </ThreadDetailsSection>
      ) : null}
    </>
  );
}
