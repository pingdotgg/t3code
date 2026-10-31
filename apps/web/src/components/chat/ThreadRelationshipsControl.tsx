import { formatModelSlugName } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
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
  BotIcon,
  EllipsisIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  MessagesSquareIcon,
  HistoryIcon,
  MessageSquareIcon,
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
} from "../../state/entities";
import { useEnvironment, useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  shouldShowInstanceBadge,
} from "../../providerInstances";
import { threadEnvironment } from "../../state/threads";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";
import { ThreadLineageWorkflowRow } from "./ThreadLineageWorkflowRow";
import { openSideChatTab } from "../../lib/sideChatPane";

import { Menu, MenuItem, MenuItemLabel, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { Spinner } from "../ui/spinner";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  THREAD_DETAILS_PANEL_ACTION_GROUP_CLASS,
  THREAD_DETAILS_PANEL_META_CLASS,
} from "./threadDetailsPanelStyles";

// Page both inline relationships and the previous-agent menu so long histories
// stay bounded inside the card and popup.
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
  readonly menu?: boolean;
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
        <ThreadDetailsControl
          onClick={props.onShowMore}
          tone="muted"
          render={props.menu ? <MenuItem closeOnClick={false} /> : undefined}
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          Show {Math.min(props.hiddenCount, THREAD_LINEAGE_PAGE_COUNT)} more
        </ThreadDetailsControl>
      ) : null}
    </>
  );
}

function ThreadLineageGroup(props: {
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
  const rows = (
    <ThreadLineageRowList
      menu={props.label !== null}
      hiddenCount={hiddenCount}
      onShowMore={() => setVisibleCount((count) => count + THREAD_LINEAGE_PAGE_COUNT)}
    >
      {props.children(visibleRows)}
    </ThreadLineageRowList>
  );
  if (!props.label) return rows;
  return (
    <Menu open={expanded} onOpenChange={setExpanded}>
      <MenuTrigger render={<ThreadDetailsControl part="choice" aria-label="Previous agents" />}>
        <HistoryIcon />
        <MenuItemLabel className="min-w-0 flex-1">{props.label}</MenuItemLabel>
        <span className={THREAD_DETAILS_PANEL_META_CLASS}>
          {failedCount > 0 ? (
            <span className="text-destructive-foreground">{failedCount} failed ·</span>
          ) : null}
          {props.rows.length}
        </span>
      </MenuTrigger>
      <MenuPopup side="right" align="start" className="w-75">
        {rows}
      </MenuPopup>
    </Menu>
  );
}

function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId) {
  if (edge.kind === "transfer") return "Context transfer";
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Parent thread";
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
      <span className="block text-meta">{props.title}</span>
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
 * A task delegated to a linked environment. It has no thread here, so it opens
 * the thread there, when this client is connected to that environment.
 */
function RemoteSubagentRow(props: {
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
    <li className="group relative flex items-center">
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
            <span className="block truncate text-left text-label text-strong-foreground">
              {title}
            </span>
          </span>
          <span
            className={`shrink-0 text-caption ${failed ? "text-destructive-foreground" : "text-dim-foreground"}`}
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
function DelegatedFromRow(props: {
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
    <li className="group relative flex items-center">
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
            <span className="block truncate text-left text-label text-strong-foreground">
              {title}
            </span>
          </span>
          {label ? (
            <span className="shrink-0 text-caption text-dim-foreground">on {label}</span>
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

export function ThreadRelationshipsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly showLineage: boolean;
  readonly showSideChats: boolean;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const providersByEnvironment = useEnvironmentProviders();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const relationshipShells = useThreadRelationshipShells(ref);
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
  const parentProjection = useThreadProjection(parentRef)?.projection;
  const navigate = useNavigate();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const stopWorkflowCommand = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const canOperateWorkflow = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(props.environmentId),
  );
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const mergeErrorToastId = useRef<string | null>(null);
  const detachErrorToastId = useRef<string | null>(null);
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
    deriveWorkflowGroups(runtimeSubagents).map((group) => [group.workflow.id, group]),
  );
  const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
    ...relationshipShells,
    ...(archivedShells ?? []),
  ];
  const graph = deriveThreadRelationshipGraph({ threads: shells, projection });
  const currentProject = projects.find((project) => project.id === currentThread?.projectId);
  const latestMergeBackRun = projection === null ? null : resolveLatestMergeBackRun(projection);
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, props.threadId),
    currentThreadId: props.threadId,
    mergeTargetThreadId,
  }).map((row) => {
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
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;

  const {
    related = [],
    active = [],
    previous = [],
    sideChats = [],
  } = groupBy(relationshipRows, ({ threadId, edge }) => {
    const isParent = isParentThreadRelationship(edge, props.threadId);
    if (!isParent && graph.nodes.get(threadId)?.thread?.lineage.sideChat === true)
      return "sideChats";
    if (edge.kind !== "subagent" || isParent) return "related";
    return ["completed", "failed", "error", "cancelled", "interrupted", "idle"].includes(
      edge.status ?? "",
    )
      ? "previous"
      : "active";
  });
  const groups = [
    { id: "related", label: null, rows: related, expanded: true },
    { id: "active", label: null, rows: active, expanded: true },
    { id: "previous", label: "Previous agents", rows: previous, expanded: false },
  ];
  // Tasks running in a linked environment have no thread here; they get their own rows.
  const remoteSubagents = (projection?.subagents ?? []).filter(
    (agent): agent is OrchestrationV2Subagent & { remoteChild: OrchestrationV2RemoteTaskChild } =>
      agent.remoteChild !== undefined,
  );
  const unlinkedRunningCount =
    projection?.subagents.filter(
      (agent) =>
        agent.remoteChild === undefined &&
        agent.childThreadId === null &&
        agent.status === "running",
    ).length ?? 0;

  // A linked environment's agent may have delegated this thread from there.
  const delegatedFrom = currentThread?.delegatedFrom;

  const lineageVisible =
    props.showLineage &&
    (related.length > 0 ||
      active.length > 0 ||
      previous.length > 0 ||
      unlinkedRunningCount > 0 ||
      remoteSubagents.length > 0 ||
      delegatedFrom !== undefined ||
      // Disconnect lives in this heading, so a thread with only side chats still shows it.
      (canDetach && sideChats.length > 0));
  const sideChatsVisible = props.showSideChats && sideChats.length > 0;
  const runningSideChats = sideChats.filter(({ edge }) => edge.status === "running").length;

  if (!lineageVisible && !sideChatsVisible) {
    return null;
  }

  // Idle children can be omitted from the shell; opening one loads its own detail.
  const openThread = (threadId: ThreadId) => {
    if (openSideChatTab(ref, graph.nodes.get(threadId)?.thread ?? null)) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
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
        title: "Could not merge back",
      });
      return;
    }
    openThread(mergeTargetThreadId);
  };

  const detach = async () => {
    if (!canDetach || busyAction !== null) return;
    if (detachErrorToastId.current !== null) {
      toastManager.close(detachErrorToastId.current);
      detachErrorToastId.current = null;
    }
    setBusyAction("detach");
    const result = await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setBusyAction(null);
    if (result._tag === "Failure") {
      detachErrorToastId.current = toastManager.add({
        type: "error",
        title: "Could not disconnect agent session",
      });
    }
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
      toastManager.add({ type: "error", title: "Could not stop subagent" });
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
      toastManager.add({ type: "error", title: "Could not stop workflow" });
    }
  };

  const parentTitle =
    mergeTargetThreadId === null
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
    const relationship =
      node?.thread?.lineage.sideChat === true && !isParent
        ? "Side chat"
        : relationshipLabel(edge, props.threadId);
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
        workflowGroup?.workflow.workflowName ?? node?.thread?.title ?? agent?.title ?? threadId,
      isSubagent,
    });
    const provider = providers?.find(
      (entry) =>
        entry.instanceId === (agent?.providerInstanceId ?? node?.thread?.providerInstanceId),
    );
    const providerDriver = agent?.driver ?? provider?.driver;
    const providerEntry = providerEntries.find(
      (entry) =>
        entry.instanceId === (agent?.providerInstanceId ?? node?.thread?.providerInstanceId),
    );
    const canStopWorkflow =
      canOperateWorkflow &&
      workflowGroup?.workflow.status === "running" &&
      agent?.origin === "provider_native" &&
      providerDriver === "claudeAgent";
    const trailingVisibilityClass = (workflowGroup ? canStopWorkflow : canStop)
      ? "group-hover:opacity-0 group-focus-within:opacity-0 pointer-coarse:opacity-0 [@media(hover:none)]:opacity-0"
      : "";
    const project = projects.find((project) => project.id === node?.thread?.projectId);
    const relationshipHint = `Open ${relationship.toLowerCase()} in this chat`;
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
      <LineageTooltipContent title={threadTitle} hint={relationshipHint} />
    );
    const relationshipContent = (
      <>
        {providerDriver ? (
          <ProviderInstanceIcon
            driverKind={providerDriver}
            displayName={providerEntry?.displayName ?? provider?.displayName ?? providerDriver}
            accentColor={providerEntry?.accentColor}
            acpRegistryAgentId={providerEntry?.acpRegistryAgentId}
            acpRegistryIconUrl={providerEntry?.acpRegistryIconUrl ?? provider?.iconUrl}
            showBadge={
              providerEntry !== undefined && shouldShowInstanceBadge(providerEntry, providerEntries)
            }
            size="compact"
            iconClassName="size-4"
            className="z-auto"
          />
        ) : (
          <RelationshipIcon className="size-4 text-muted-foreground" />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-meta">{threadTitle}</span>
          <span className="truncate text-caption text-muted-foreground">
            {relationship}
            {node?.thread?.modelSelection.model
              ? ` · ${formatModelSlugName(node.thread.modelSelection.model)}`
              : ""}
          </span>
        </span>
        <span className={`${THREAD_DETAILS_PANEL_META_CLASS} ${trailingVisibilityClass}`}>
          {isParent ? (
            "Parent"
          ) : !isSubagent ? (
            edge.kind === "transfer" ? (
              relationship
            ) : (
              "Fork"
            )
          ) : failed ? (
            <span className="text-destructive-foreground">Failed</span>
          ) : (
            <>
              {agent && deriveSubagentElapsedMs(agent, 0) !== null ? (
                <AgentElapsed agent={agent} compact />
              ) : (
                threadRelationshipStatusLabel(rowStatus)
              )}
              {rowStatus === "running" || rowStatus === "in_progress" ? (
                <Spinner size="xs" tone="muted" aria-label="Running" />
              ) : null}
            </>
          )}
        </span>
      </>
    );
    // A workflow pairs its menu row with a disclosure; other rows render directly.
    const relationshipLink = (
      <Tooltip>
        <TooltipTrigger
          delay={200}
          render={
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              multiline
              className={workflowGroup ? "flex-1" : undefined}
              render={previous.some((row) => row.threadId === threadId) ? <MenuItem /> : undefined}
              onClick={() => openThread(threadId)}
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
          onOpenThread={(memberThreadId) => openThread(memberThreadId as ThreadId)}
          onStop={canStopWorkflow ? () => void stopWorkflow(agent.id) : undefined}
          stopping={stoppingId === agent.id}
          stopDisabled={stoppingId !== null}
          header={relationshipLink}
        />
      );
    }
    return (
      <li key={threadId} className="group relative flex items-center">
        {isMergeTarget ? (
          <div className={THREAD_DETAILS_PANEL_ACTION_GROUP_CLASS}>
            <Tooltip>
              <TooltipTrigger
                delay={200}
                render={
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    className="flex-1"
                    aria-label={`${threadTitle} ${threadRelationshipStatusLabel(rowStatus)}`}
                    onClick={() => openThread(threadId)}
                  />
                }
              >
                {relationshipContent}
              </TooltipTrigger>
              <RelationshipPopup side="left">{relationshipTooltip}</RelationshipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="icon"
                    aria-label={
                      parentTitle
                        ? `Merge back to ${parentTitle}`
                        : "Merge back to source conversation"
                    }
                    disabled={!canMerge || busyAction !== null}
                    onClick={() => void merge()}
                  >
                    {busyAction === "merge" ? (
                      <Spinner size="xs" />
                    ) : (
                      <PullRequestGlyph.merged className="size-3" />
                    )}
                  </ThreadDetailsControl>
                }
              />
              <TooltipPopup side="left">
                {latestMergeBackRun === null
                  ? "Complete a run in this fork before merging it back"
                  : parentTitle
                    ? `Merge this conversation back into ${parentTitle}`
                    : "Merge this conversation back into its source"}
              </TooltipPopup>
            </Tooltip>
            <span className="shrink-0 border border-transparent ps-1 pe-2.5 text-caption text-muted-foreground">
              {threadRelationshipStatusLabel(rowStatus)}
            </span>
          </div>
        ) : (
          relationshipLink
        )}
        {canStop && agent ? (
          <div className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    size="icon-xs"
                    variant="ghost"
                    part="icon"
                    tone="destructive"
                    aria-label={`Stop subagent ${threadTitle}`}
                    disabled={stoppingId !== null}
                    onClick={() => void stopSubagent(threadId, agent)}
                  />
                }
              >
                {stoppingId === threadId ? (
                  <Spinner aria-hidden size="xs" />
                ) : (
                  <SquareIcon aria-hidden className="size-3 fill-current" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="left">Stop subagent</TooltipPopup>
            </Tooltip>
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <>
      {lineageVisible ? (
        <ThreadDetailsSection
          title="Lineage"
          summary={
            unlinkedRunningCount +
              (groups.find((group) => group.id === "active")?.rows.length ?? 0) >
            0
              ? `${unlinkedRunningCount + (groups.find((group) => group.id === "active")?.rows.length ?? 0)} running`
              : undefined
          }
          action={
            canDetach ? (
              <Menu>
                <MenuTrigger
                  render={<ThreadDetailsControl part="icon" aria-label="Lineage actions" />}
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem disabled={busyAction !== null} onClick={() => void detach()}>
                    <UnplugIcon />
                    <MenuItemLabel>Disconnect agent session</MenuItemLabel>
                  </MenuItem>
                </MenuPopup>
              </Menu>
            ) : undefined
          }
          data-thread-relationships-panel
        >
          {delegatedFrom === undefined ? null : (
            <ThreadLineageRowList hiddenCount={0} onShowMore={() => {}}>
              <DelegatedFromRow
                delegatedFrom={delegatedFrom}
                fallbackLabel={currentThread?.linkOrigin?.label}
              />
            </ThreadLineageRowList>
          )}
          {groups
            .filter((group) => group.id !== "previous")
            .map((group) => (
              <ThreadLineageGroup key={`${scopedThreadKey(ref)}:${group.id}`} {...group}>
                {(visibleRows) => visibleRows.map(renderRelationshipRow)}
              </ThreadLineageGroup>
            ))}
          {currentThread ? (
            <div
              className="mx-0.5 flex min-h-9 items-center gap-2.5 rounded-lg bg-foreground/4 ps-2.5 pe-1"
              aria-current="true"
            >
              <MessageSquareIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-meta">{currentThread.title}</span>
                <span className="truncate text-caption text-muted-foreground">
                  This thread · {formatModelSlugName(currentThread.modelSelection.model)}
                </span>
              </span>
            </div>
          ) : null}
          {groups
            .filter((group) => group.id === "previous")
            .map((group) => (
              <ThreadLineageGroup key={`${scopedThreadKey(ref)}:${group.id}`} {...group}>
                {(visibleRows) => visibleRows.map(renderRelationshipRow)}
              </ThreadLineageGroup>
            ))}
          {remoteSubagents.length > 0 ? (
            <ThreadLineageRowList hiddenCount={0} onShowMore={() => {}}>
              {remoteSubagents.map((agent) => (
                <RemoteSubagentRow
                  key={agent.id}
                  agent={agent}
                  // Its provider instance belongs to the environment it runs in.
                  provider={providersByEnvironment
                    .get(agent.remoteChild.environmentId)
                    ?.find((entry) => entry.instanceId === agent.providerInstanceId)}
                />
              ))}
            </ThreadLineageRowList>
          ) : null}
          {unlinkedRunningCount > 0 ? (
            <div className="flex items-center gap-2 px-2 py-1 text-caption text-dim-foreground">
              <Spinner size="xs" tone="muted" />
              {unlinkedRunningCount}{" "}
              {unlinkedRunningCount === 1 ? "running agent" : "running agents"} preparing threads
            </div>
          ) : null}
        </ThreadDetailsSection>
      ) : null}
      {sideChatsVisible ? (
        <ThreadDetailsSection
          title="Side chats"
          summary={runningSideChats > 0 ? `${runningSideChats} running` : undefined}
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
