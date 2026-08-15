import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext } from "@dnd-kit/sortable";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import type { ChangeRequestStateLike } from "@t3tools/client-runtime/state/thread-settled";
import { type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EllipsisIcon,
  PlusIcon,
  SquarePenIcon,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { useBoardFocusStore } from "../../board/boardFocusStore.ts";
import {
  DraftId,
  composerDraftHasUserContent,
  finalizePromotedDraftThreadByRef,
  markPromotedDraftThreadByRef,
  useComposerDraftStore,
  type DraftSessionState,
} from "../../composerDraftStore.ts";
import {
  type BoardLane,
  type BoardLaneDraft,
  type BoardLaneId,
  type BoardOrganizationColumns,
  type BoardOrganizationRows,
  clampBoardLaneWidth,
  BOARD_LANE_MAX_WIDTH,
  BOARD_LANE_MIN_WIDTH,
  orderBoardLaneEntries,
  selectBoardPlacement,
  selectBoardLaneWidth,
  useBoardLaneStore,
} from "../../board/boardLaneStore.ts";
import {
  isBoardFixedLaneId,
  isBoardWorkflowLane,
  boardLaneLabel,
  orderBoardLanes,
  resolveBoardLane,
} from "../../board/boardLanes.ts";
import {
  BOARD_STATE_BY_ID,
  BOARD_STATES,
  boardStateDimensionKey,
  buildBoardRows,
  resolveBoardThreadState,
  type BoardStateId,
} from "../../board/boardOrganization.ts";
import { selectProjectGroupingSettings } from "../../logicalProject.ts";
import { ensureLocalApi } from "../../localApi.ts";
import { useProjectScopeStore } from "../../projectScopeStore.ts";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping.ts";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments.ts";
import {
  useProjects,
  useServerConfigs,
  useThreadDetail,
  useThreadShells,
} from "../../state/entities.ts";
import type { SidebarThreadSummary } from "../../types.ts";
import { useNowMinute } from "../../hooks/useNowMinute.ts";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover.tsx";
import { SidebarInset } from "../ui/sidebar.tsx";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Textarea } from "../ui/textarea.tsx";
import { cn } from "~/lib/utils";
import { useClientSettings } from "~/hooks/useSettings";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";
import { BoardChangeRequestStateReporter, BoardSessionCard } from "./BoardSessionCard.tsx";
import { BoardDraftCard } from "./BoardDraftCard.tsx";
import { BoardCardExpandedSheet } from "./BoardCardExpandedSheet.tsx";
import { threadHasStarted } from "../ChatView.logic.ts";
import {
  boardLaneGridTemplateColumns,
  boardLaneHeaderDroppableId,
  boardProjectKey,
  groupEntriesByLane,
  laneArchiveIntent,
  laneIdForName,
  nextLaneOrder,
  reorderLaneUpdates,
  resolveBoardLaneDrop,
  reorderBoardLaneKeys,
  rowKeyFromSwimlaneDroppableId,
  resolveBoardFocusAction,
  resolveBoardScrollTarget,
  resolveBoardThreadVisibility,
  swimlaneColumnDroppableId,
} from "./SessionBoard.logic.ts";

/** Group bands stick directly under the lane header row. */
const BOARD_HEADER_HEIGHT = "3.25rem";
/** The rule that makes a lane read as one column down the whole scroll. */
const BOARD_COLUMN_RULE_CLASS = "border-l border-border/40 first:border-l-0";

interface PlacedEntryBase {
  readonly ref: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly key: string;
  readonly laneId: BoardLaneId;
  readonly workflowLaneId: BoardLaneId;
  readonly boardStateId: BoardStateId;
  readonly environmentLabel: string;
  readonly projectKey: string;
  readonly projectTitle: string;
  readonly laneColumnKey: string;
  readonly createdAt: string;
}

interface PlacedThread extends PlacedEntryBase {
  readonly kind: "thread";
  readonly thread: SidebarThreadSummary;
  readonly environmentConnection: EnvironmentConnectionPresentation;
}

interface PlacedDraft extends PlacedEntryBase {
  readonly kind: "draft";
  readonly draftId: DraftId;
  readonly draft: DraftSessionState;
}

type PlacedEntry = PlacedThread | PlacedDraft;

interface WorkflowBoardColumn {
  readonly kind: "workflow";
  readonly key: string;
  readonly lane: BoardLane;
  readonly label: string;
}

interface StateBoardColumn {
  readonly kind: "state";
  readonly key: string;
  readonly stateId: BoardStateId;
  readonly label: string;
}

type BoardColumn = WorkflowBoardColumn | StateBoardColumn;

type LaneDraft = BoardLaneDraft;

function laneColumnKey(laneId: BoardLaneId): string {
  return laneId;
}

function findCardNode(scroller: HTMLElement | null, threadKey: string): HTMLElement | null {
  // Matched by dataset rather than an attribute selector: thread keys are
  // `environmentId:threadId` and are not guaranteed selector-safe.
  for (const node of scroller?.querySelectorAll<HTMLElement>("[data-board-card-key]") ?? []) {
    if (node.dataset.boardCardKey === threadKey) return node;
  }
  return null;
}

export function SessionBoard() {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const nowMinute = useNowMinute();
  const settlementNow = `${nowMinute}:00.000Z`;
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const projectScopeKey = useProjectScopeStore((state) => state.projectScopeKey);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [changeRequestResolutionByKey, setChangeRequestResolutionByKey] = useState<
    ReadonlyMap<
      string,
      { readonly sourceKey: string; readonly state: ChangeRequestStateLike | null }
    >
  >(() => new Map());
  const [collapsedProjectKeys, setCollapsedProjectKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const expandedTarget = useBoardFocusStore((state) => state.expandedTarget);
  const setExpandedTarget = useBoardFocusStore((state) => state.setExpanded);
  const expandedDraft = useComposerDraftStore((state) =>
    expandedTarget?.kind === "draft" ? state.getDraftSession(expandedTarget.draftId) : null,
  );
  const draftThreadsByThreadKey = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  const investedDraftIds = useComposerDraftStore(
    useShallow((state) =>
      Object.entries(state.draftThreadsByThreadKey)
        .filter(
          ([draftId, draft]) =>
            draft.promotedTo == null &&
            composerDraftHasUserContent(state.draftsByThreadKey[draftId]),
        )
        .map(([draftId]) => draftId)
        .toSorted(),
    ),
  );
  const clearDraftThread = useComposerDraftStore((state) => state.clearDraftThread);
  const handleNewThread = useNewThreadHandler();
  const organization = useBoardLaneStore((state) => state.organization);
  const setOrganizationColumns = useBoardLaneStore((state) => state.setOrganizationColumns);
  const setOrganizationRows = useBoardLaneStore((state) => state.setOrganizationRows);
  const lanes = useBoardLaneStore((state) => state.lanes);
  const placementByThreadKey = useBoardLaneStore((state) => state.placementByThreadKey);
  const laneEntryByThreadKey = useBoardLaneStore((state) => state.laneEntryByThreadKey);
  const orderByLaneId = useBoardLaneStore((state) => state.orderByLaneId);
  const setPlacement = useBoardLaneStore((state) => state.setPlacement);
  const recordLaneEntry = useBoardLaneStore((state) => state.recordLaneEntry);
  const setLaneOrder = useBoardLaneStore((state) => state.setLaneOrder);
  const createLane = useBoardLaneStore((state) => state.createLane);
  const updateLane = useBoardLaneStore((state) => state.updateLane);
  const archiveLane = useBoardLaneStore((state) => state.archiveLane);
  const laneWidthsByKey = useBoardLaneStore((state) => state.byLaneColumnKey);
  const setLaneWidth = useBoardLaneStore((state) => state.setWidth);
  const [draggingLaneWidth, setDraggingLaneWidth] = useState<{
    readonly key: string;
    readonly widthPx: number;
  } | null>(null);
  const projectTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects) {
      map.set(`${project.environmentId}:${project.id}`, project.title);
    }
    return map;
  }, [projects]);
  const projectByPhysicalKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [boardProjectKey(project.environmentId, project.id), project]),
      ),
    [projects],
  );

  const { projectGroupByPhysicalKey, projectRefByGroupKey } = useMemo(() => {
    const groups = buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
    const map = new Map<string, { readonly projectKey: string; readonly projectTitle: string }>();
    const refs = new Map<string, ReturnType<typeof scopeProjectRef>>();
    for (const group of groups) {
      refs.set(group.projectKey, scopeProjectRef(group.environmentId, group.id));
      for (const projectRef of group.memberProjectRefs) {
        map.set(boardProjectKey(projectRef.environmentId, projectRef.projectId), {
          projectKey: group.projectKey,
          projectTitle: group.displayName,
        });
      }
    }
    return { projectGroupByPhysicalKey: map, projectRefByGroupKey: refs };
  }, [primaryEnvironmentId, projectGroupingSettings, projects]);

  useEffect(() => {
    // Expansion describes an overlay on this particular board visit. Returning
    // from a full-screen route must always reveal the board itself first.
    setExpandedTarget(null);
    return () => setExpandedTarget(null);
  }, [setExpandedTarget]);

  useEffect(() => {
    if (expandedTarget?.kind === "draft" && expandedDraft === null) {
      setExpandedTarget(null);
    }
  }, [expandedDraft, expandedTarget, setExpandedTarget]);

  const environmentById = useMemo(
    () => new Map(environments.map((environment) => [environment.environmentId, environment])),
    [environments],
  );

  const workflowLanes = useMemo(() => orderBoardLanes(lanes).filter(isBoardWorkflowLane), [lanes]);
  const workflowColumns = useMemo<ReadonlyArray<WorkflowBoardColumn>>(
    () =>
      workflowLanes.map((lane) => ({
        kind: "workflow",
        key: laneColumnKey(lane.id),
        lane,
        label: lane.name,
      })),
    [workflowLanes],
  );
  const boardColumns = useMemo<ReadonlyArray<BoardColumn>>(
    () =>
      organization.columns === "workflow"
        ? workflowColumns
        : BOARD_STATES.map((state) => ({
            kind: "state" as const,
            key: boardStateDimensionKey(state.id),
            stateId: state.id,
            label: state.label,
          })),
    [organization.columns, workflowColumns],
  );

  const boardGridTemplateColumns = useMemo(() => {
    const widths =
      draggingLaneWidth === null
        ? laneWidthsByKey
        : {
            ...laneWidthsByKey,
            [draggingLaneWidth.key]: { widthPx: draggingLaneWidth.widthPx },
          };
    return boardLaneGridTemplateColumns(
      boardColumns.map((column) => ({ key: column.key, laneId: column.key })),
      Object.fromEntries(
        boardColumns.map((column) => [
          column.key,
          widths[column.key]?.widthPx ?? selectBoardLaneWidth(widths, column.key),
        ]),
      ),
    );
  }, [boardColumns, draggingLaneWidth, laneWidthsByKey]);

  const handleCreateLane = useCallback(
    async (draft: LaneDraft) => {
      createLane({ id: laneIdForName(draft.name, lanes), ...draft });
      return true;
    },
    [createLane, lanes],
  );

  const handleUpdateLane = useCallback(
    async (laneId: BoardLaneId, draft: LaneDraft) => {
      updateLane(laneId, draft);
      return true;
    },
    [updateLane],
  );

  const handleReorderLane = useCallback(
    async (laneId: BoardLaneId, direction: "up" | "down") => {
      for (const input of reorderLaneUpdates(lanes, laneId, direction)) {
        updateLane(input.laneId, {
          name: lanes.find((lane) => lane.id === input.laneId)?.name ?? input.laneId,
          description: lanes.find((lane) => lane.id === input.laneId)?.description ?? "",
          order: input.order,
        });
      }
    },
    [lanes, updateLane],
  );

  const handleArchiveLane = useCallback(
    async (laneId: BoardLaneId, memberCount: number) => {
      const intent = laneArchiveIntent(laneId, memberCount);
      if (
        intent.kind === "confirm" &&
        !(await ensureLocalApi().dialogs.confirm(intent.explanation))
      ) {
        return false;
      }
      archiveLane(laneId);
      return true;
    },
    [archiveLane],
  );

  const handleChangeRequestState = useCallback(
    (threadKey: string, sourceKey: string, state: ChangeRequestStateLike | null) => {
      setChangeRequestResolutionByKey((current) => {
        const existing = current.get(threadKey);
        if (existing?.sourceKey === sourceKey && existing.state === state) return current;
        const next = new Map(current);
        next.set(threadKey, { sourceKey, state });
        return next;
      });
    },
    [],
  );

  const { changeRequestSourceKeyByThreadKey, changeRequestReporterGroups } = useMemo(() => {
    const sourceKeyByThreadKey = new Map<string, string>();
    const groups = new Map<
      string,
      {
        readonly environmentId: SidebarThreadSummary["environmentId"];
        readonly workspacePath: string;
        readonly threads: Array<{
          readonly cardKey: string;
          readonly branch: string;
          readonly sourceKey: string;
        }>;
      }
    >();
    for (const thread of threads) {
      const supportsSettlement =
        serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
      if (thread.archivedAt !== null || !supportsSettlement || thread.branch === null) continue;
      const projectKey = boardProjectKey(thread.environmentId, thread.projectId);
      const project = projectByPhysicalKey.get(projectKey);
      const cardKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      if (!project) {
        sourceKeyByThreadKey.set(cardKey, `pending-project:${projectKey}:${thread.branch}`);
        continue;
      }
      const workspacePath = thread.worktreePath ?? project.workspaceRoot;
      const workspaceKey = `${thread.environmentId}:${workspacePath}`;
      const sourceKey = `${workspaceKey}:${thread.branch}`;
      sourceKeyByThreadKey.set(cardKey, sourceKey);
      const group = groups.get(workspaceKey) ?? {
        environmentId: thread.environmentId,
        workspacePath,
        threads: [],
      };
      group.threads.push({ cardKey, branch: thread.branch, sourceKey });
      groups.set(workspaceKey, group);
    }
    return {
      changeRequestSourceKeyByThreadKey: sourceKeyByThreadKey,
      changeRequestReporterGroups: [...groups.entries()],
    };
  }, [projectByPhysicalKey, serverConfigs, threads]);

  const changeRequestStateForThread = useCallback(
    (threadKey: string): ChangeRequestStateLike | null => {
      const expectedSourceKey = changeRequestSourceKeyByThreadKey.get(threadKey);
      const resolution = changeRequestResolutionByKey.get(threadKey);
      return expectedSourceKey !== undefined && resolution?.sourceKey === expectedSourceKey
        ? resolution.state
        : null;
    },
    [changeRequestResolutionByKey, changeRequestSourceKeyByThreadKey],
  );

  const { placedThreads, nextSnoozeWakeAtMs } = useMemo<{
    readonly placedThreads: ReadonlyArray<PlacedThread>;
    readonly nextSnoozeWakeAtMs: number | null;
  }>(() => {
    // Inactivity settlement is minute-granular. Snoozes get an exact wake
    // timer below, whose tick asks this memo for a fresh wall clock.
    void nowMinute;
    void snoozeWakeTick;
    const now = new Date().toISOString();
    let nextWakeAtMs = Number.POSITIVE_INFINITY;
    return {
      placedThreads: threads
        .map<PlacedThread | null>((thread) => {
          const ref = scopeThreadRef(thread.environmentId, thread.id);
          const key = scopedThreadKey(ref);
          const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
          const visibility = resolveBoardThreadVisibility(thread, {
            now,
            settlementNow,
            autoSettleAfterDays,
            supportsSettlement: capabilities?.threadSettlement === true,
            supportsSnooze: capabilities?.threadSnooze === true,
            changeRequestState: changeRequestStateForThread(key),
          });
          if (visibility === "archived") return null;
          if (visibility === "snoozed" && thread.snoozedUntil != null) {
            const wakeAtMs = Date.parse(thread.snoozedUntil);
            if (!Number.isNaN(wakeAtMs)) nextWakeAtMs = Math.min(nextWakeAtMs, wakeAtMs);
          }
          const workflowLaneId = resolveBoardLane(
            selectBoardPlacement(placementByThreadKey, ref),
            lanes,
          );
          if (workflowLaneId === null) return null;
          const boardStateId = resolveBoardThreadState(thread, visibility);
          if (boardStateId === null) return null;
          const columnKey =
            organization.columns === "workflow"
              ? laneColumnKey(workflowLaneId)
              : boardStateDimensionKey(boardStateId);
          const physicalProjectKey = boardProjectKey(thread.environmentId, thread.projectId);
          const projectGroup = projectGroupByPhysicalKey.get(physicalProjectKey);
          return {
            kind: "thread",
            ref,
            environmentId: thread.environmentId,
            key,
            thread,
            laneId: workflowLaneId,
            workflowLaneId,
            boardStateId,
            environmentLabel:
              environmentById.get(thread.environmentId)?.label ?? thread.environmentId,
            environmentConnection: environmentById.get(thread.environmentId)?.connection ?? {
              phase: "available",
              error: null,
              traceId: null,
            },
            projectKey: projectGroup?.projectKey ?? physicalProjectKey,
            projectTitle:
              projectGroup?.projectTitle ?? projectTitleById.get(physicalProjectKey) ?? "Project",
            laneColumnKey: columnKey,
            createdAt: thread.createdAt,
          };
        })
        .filter((entry): entry is PlacedThread => entry !== null),
      nextSnoozeWakeAtMs: Number.isFinite(nextWakeAtMs) ? nextWakeAtMs : null,
    };
  }, [
    autoSettleAfterDays,
    changeRequestStateForThread,
    environmentById,
    lanes,
    organization.columns,
    settlementNow,
    placementByThreadKey,
    projectGroupByPhysicalKey,
    projectTitleById,
    serverConfigs,
    snoozeWakeTick,
    threads,
  ]);

  const serverThreadKeySet = useMemo(
    () => new Set(placedThreads.map((entry) => entry.key)),
    [placedThreads],
  );
  const placedDrafts = useMemo<ReadonlyArray<PlacedDraft>>(() => {
    const entries: PlacedDraft[] = [];
    const investedDraftIdSet = new Set(investedDraftIds);
    for (const [rawDraftId, draft] of Object.entries(draftThreadsByThreadKey)) {
      if (draft.promotedTo != null || !investedDraftIdSet.has(rawDraftId)) continue;
      const draftId = DraftId.make(rawDraftId);
      const ref = scopeThreadRef(draft.environmentId, draft.threadId);
      const key = scopedThreadKey(ref);
      // Once the server shell exists it owns this identity. A promotion
      // reconciler below removes the draft after the real thread has started.
      if (serverThreadKeySet.has(key)) continue;
      const workflowLaneId = resolveBoardLane(
        selectBoardPlacement(placementByThreadKey, ref),
        lanes,
      );
      if (workflowLaneId === null) continue;
      const physicalProjectKey = boardProjectKey(draft.environmentId, draft.projectId);
      const projectGroup = projectGroupByPhysicalKey.get(physicalProjectKey);
      entries.push({
        kind: "draft",
        draftId,
        draft,
        ref,
        environmentId: draft.environmentId,
        key,
        laneId: workflowLaneId,
        workflowLaneId,
        boardStateId: "draft",
        environmentLabel: environmentById.get(draft.environmentId)?.label ?? draft.environmentId,
        projectKey: projectGroup?.projectKey ?? physicalProjectKey,
        projectTitle:
          projectGroup?.projectTitle ?? projectTitleById.get(physicalProjectKey) ?? "Project",
        laneColumnKey:
          organization.columns === "workflow"
            ? laneColumnKey(workflowLaneId)
            : boardStateDimensionKey("draft"),
        createdAt: draft.createdAt,
      });
    }
    return entries;
  }, [
    draftThreadsByThreadKey,
    environmentById,
    investedDraftIds,
    lanes,
    organization.columns,
    placementByThreadKey,
    projectGroupByPhysicalKey,
    projectTitleById,
    serverThreadKeySet,
  ]);

  const placed = useMemo<ReadonlyArray<PlacedEntry>>(
    () => [...placedThreads, ...placedDrafts],
    [placedDrafts, placedThreads],
  );
  const orderedPlaced = useMemo(
    () => orderBoardLaneEntries(placed, laneEntryByThreadKey, orderByLaneId),
    [laneEntryByThreadKey, orderByLaneId, placed],
  );

  useEffect(() => {
    for (const entry of placed) {
      const expectedSourceKey =
        entry.kind === "thread" ? changeRequestSourceKeyByThreadKey.get(entry.key) : undefined;
      if (
        expectedSourceKey !== undefined &&
        changeRequestResolutionByKey.get(entry.key)?.sourceKey !== expectedSourceKey
      ) {
        continue;
      }
      const current = laneEntryByThreadKey[entry.key];
      if (current?.laneId === entry.laneId) continue;
      // Implicit Triage has creation time as its natural arrival and needs no local write.
      if (
        current === undefined &&
        entry.laneId === entry.workflowLaneId &&
        selectBoardPlacement(placementByThreadKey, entry.ref) === undefined
      ) {
        continue;
      }
      recordLaneEntry(entry.ref, entry.laneId);
    }
  }, [
    changeRequestResolutionByKey,
    changeRequestSourceKeyByThreadKey,
    laneEntryByThreadKey,
    placed,
    placementByThreadKey,
    recordLaneEntry,
  ]);

  useEffect(() => {
    if (nextSnoozeWakeAtMs === null) return;
    const delayMs = Math.min(Math.max(0, nextSnoozeWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [nextSnoozeWakeAtMs]);

  const laneMemberCountByKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of orderedPlaced) {
      counts.set(entry.laneColumnKey, (counts.get(entry.laneColumnKey) ?? 0) + 1);
    }
    return counts;
  }, [orderedPlaced]);

  const boardRows = useMemo(
    () => buildBoardRows(orderedPlaced, organization.rows, projectScopeKey),
    [orderedPlaced, organization.rows, projectScopeKey],
  );

  const toggleSwimlaneCollapsed = useCallback((projectKey: string) => {
    setCollapsedProjectKeys((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  }, []);

  const laneResizeTeardownRef = useRef<(() => void) | null>(null);
  const laneResizeFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      laneResizeTeardownRef.current?.();
      if (laneResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(laneResizeFrameRef.current);
      }
    },
    [],
  );

  const handleLaneResizePointerDown = useCallback(
    (laneColumnKeyValue: string, widthPx: number, event: ReactPointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      laneResizeTeardownRef.current?.();

      const startX = event.clientX;
      const startWidth = widthPx;
      let latest = startWidth;
      const pointerId = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(pointerId);
      } catch {
        // Window listeners below keep resizing functional without pointer capture.
      }

      const onMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        latest = clampBoardLaneWidth(startWidth + moveEvent.clientX - startX);
        if (laneResizeFrameRef.current !== null) return;
        laneResizeFrameRef.current = window.requestAnimationFrame(() => {
          laneResizeFrameRef.current = null;
          setDraggingLaneWidth({ key: laneColumnKeyValue, widthPx: latest });
        });
      };
      const finish = (finishEvent: PointerEvent) => {
        if (finishEvent.pointerId !== pointerId) return;
        laneResizeTeardownRef.current?.();
        if (laneResizeFrameRef.current !== null) {
          window.cancelAnimationFrame(laneResizeFrameRef.current);
          laneResizeFrameRef.current = null;
        }
        setDraggingLaneWidth(null);
        setLaneWidth(laneColumnKeyValue, latest);
      };
      const teardown = () => {
        laneResizeTeardownRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };

      laneResizeTeardownRef.current = teardown;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [setLaneWidth],
  );

  const handleLaneResizeKeyDown = useCallback(
    (laneColumnKeyValue: string, widthPx: number, event: ReactKeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? 50 : 10;
      const next =
        event.key === "ArrowLeft"
          ? widthPx - step
          : event.key === "ArrowRight"
            ? widthPx + step
            : event.key === "Home"
              ? BOARD_LANE_MIN_WIDTH
              : event.key === "End"
                ? BOARD_LANE_MAX_WIDTH
                : null;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      setLaneWidth(laneColumnKeyValue, next);
    },
    [setLaneWidth],
  );

  // Focus requests come from the sidebar, which cannot see this viewport. The
  // board reveals first and opens only when a later request follows a focus
  // acknowledgement from the card's composer.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const focusRequest = useBoardFocusStore((state) => state.request);
  const clearFocusRequest = useBoardFocusStore((state) => state.clearRequest);
  const setFocusedThreadKey = useBoardFocusStore((state) => state.setFocused);
  const setExpandedThread = useBoardFocusStore((state) => state.setExpanded);
  const placedRef = useRef(orderedPlaced);
  placedRef.current = orderedPlaced;

  useEffect(() => {
    if (focusRequest === null) return;
    const entry = placedRef.current.find((candidate) => candidate.key === focusRequest.threadKey);
    if (entry === undefined) {
      clearFocusRequest(focusRequest.threadKey, focusRequest.nonce);
      return;
    }

    const entryRow = boardRows.find((row) =>
      row.entries.some((candidate) => candidate.key === entry.key),
    );
    if (entryRow !== undefined && collapsedProjectKeys.has(entryRow.key)) {
      toggleSwimlaneCollapsed(entryRow.key);
      return;
    }

    const scroller = scrollerRef.current;
    const node = findCardNode(scroller, entry.key);
    const rawViewport = scroller?.getBoundingClientRect() ?? {
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    };
    const stickyHeaderHeight =
      scroller?.querySelector<HTMLElement>("[data-board-lane-header-row]")?.offsetHeight ?? 0;
    const stickyProjectHeight =
      scroller?.querySelector<HTMLElement>("[data-board-project-header]")?.offsetHeight ?? 0;
    const viewport = {
      ...rawViewport,
      top: Math.min(rawViewport.bottom, rawViewport.top + stickyHeaderHeight + stickyProjectHeight),
    };
    const acknowledgedFocus = useBoardFocusStore.getState().acknowledgedFocus;
    const action = resolveBoardFocusAction({
      card: node?.getBoundingClientRect() ?? null,
      viewport,
      requestNonce: focusRequest.nonce,
      acknowledgedRequestNonce:
        acknowledgedFocus?.threadKey === entry.key ? acknowledgedFocus.requestNonce : null,
    });

    setFocusedThreadKey(entry.key);

    if (action === "open") {
      clearFocusRequest(entry.key, focusRequest.nonce);
      setExpandedThread({ kind: "thread", threadKey: entry.key });
      return;
    }

    // Scroll only once the reveal above has laid out.
    const frame = requestAnimationFrame(() => {
      const currentScroller = scrollerRef.current;
      const currentNode = findCardNode(currentScroller, entry.key);
      if (currentScroller === null || currentNode === null) return;
      const raw = currentScroller.getBoundingClientRect();
      const laneHeaderHeight =
        currentScroller.querySelector<HTMLElement>("[data-board-lane-header-row]")?.offsetHeight ??
        0;
      const projectHeaderHeight =
        currentScroller.querySelector<HTMLElement>("[data-board-project-header]")?.offsetHeight ??
        0;
      const target = resolveBoardScrollTarget({
        card: currentNode.getBoundingClientRect(),
        viewport: {
          ...raw,
          top: Math.min(raw.bottom, raw.top + laneHeaderHeight + projectHeaderHeight),
        },
        scrollTop: currentScroller.scrollTop,
        scrollLeft: currentScroller.scrollLeft,
      });
      currentScroller.scrollTo({
        ...target,
        behavior: "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    clearFocusRequest,
    boardRows,
    collapsedProjectKeys,
    focusRequest,
    organization.rows,
    setExpandedThread,
    setFocusedThreadKey,
    toggleSwimlaneCollapsed,
  ]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const placedKeySet = useMemo(
    () => new Set(orderedPlaced.map((entry) => entry.key)),
    [orderedPlaced],
  );
  const collisionDetection = useCallback<CollisionDetection>(
    (args) =>
      pointerWithin(args).toSorted(
        (left, right) =>
          Number(placedKeySet.has(String(right.id))) - Number(placedKeySet.has(String(left.id))),
      ),
    [placedKeySet],
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingKey(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDraggingKey(null);
      if (organization.columns !== "workflow") return;
      const { active, over } = event;
      if (!over) return;

      const drop = resolveBoardLaneDrop({
        activeId: String(active.id),
        overId: String(over.id),
        entries: orderedPlaced,
        columns: workflowColumns,
      });
      if (drop === null) return;
      const { entry, target, overEntry } = drop;
      const targetLaneId = target.lane.id;
      const sourceRow = boardRows.find((row) =>
        row.entries.some((candidate) => candidate.key === entry.key),
      );
      const targetRowKey =
        overEntry === null
          ? rowKeyFromSwimlaneDroppableId(String(over.id))
          : boardRows.find((row) =>
              row.entries.some((candidate) => candidate.key === overEntry.key),
            )?.key;
      if (
        sourceRow !== undefined &&
        targetRowKey !== null &&
        targetRowKey !== undefined &&
        targetRowKey !== "board-lane-header" &&
        targetRowKey !== sourceRow.key
      ) {
        return;
      }

      if (overEntry !== null) {
        const sameVisibleGroup =
          organization.rows === "none" ||
          (organization.rows === "project"
            ? overEntry.projectKey === entry.projectKey
            : overEntry.boardStateId === entry.boardStateId);
        if (sameVisibleGroup) {
          const targetEntries = orderedPlaced.filter(
            (candidate) =>
              candidate.laneId === targetLaneId &&
              (organization.rows === "none" ||
                (organization.rows === "project"
                  ? candidate.projectKey === entry.projectKey
                  : candidate.boardStateId === entry.boardStateId)),
          );
          const translated = active.rect.current.translated;
          const insertAfter =
            translated !== null &&
            (Math.abs(translated.top - over.rect.top) < over.rect.height / 2
              ? translated.left + translated.width / 2 > over.rect.left + over.rect.width / 2
              : translated.top + translated.height / 2 > over.rect.top + over.rect.height / 2);
          const scopedOrder = reorderBoardLaneKeys({
            orderedKeys: targetEntries.map((candidate) => candidate.key),
            activeKey: entry.key,
            overKey: overEntry.key,
            insertAfter,
          });
          if (entry.laneId !== targetLaneId) setPlacement(entry.ref, targetLaneId);

          // Persist a complete lane order. When grouped, preserve the other
          // alphabetical project slices around the reordered project slice.
          const scopedSet = new Set(scopedOrder);
          const fullLaneOrder = orderedPlaced
            .filter((candidate) => candidate.laneId === targetLaneId)
            .map((candidate) => candidate.key)
            .filter((key) => !scopedSet.has(key));
          const firstScopedIndex = orderedPlaced
            .filter((candidate) => candidate.laneId === targetLaneId)
            .findIndex((candidate) => scopedSet.has(candidate.key));
          fullLaneOrder.splice(Math.max(0, firstScopedIndex), 0, ...scopedOrder);
          setLaneOrder(targetLaneId, fullLaneOrder);
          return;
        }
      }

      if (entry.laneId !== targetLaneId) {
        setPlacement(entry.ref, targetLaneId);
        return;
      }

      // Dropping on the current lane header is an explicit new lane entry:
      // place it at the top without involving activity timestamps.
      const laneOrder = orderedPlaced
        .filter((candidate) => candidate.laneId === targetLaneId && candidate.key !== entry.key)
        .map((candidate) => candidate.key);
      setLaneOrder(targetLaneId, [entry.key, ...laneOrder]);
    },
    [
      orderedPlaced,
      boardRows,
      organization.columns,
      organization.rows,
      setLaneOrder,
      setPlacement,
      workflowColumns,
    ],
  );

  const draftPromotionPairs = useMemo(() => {
    const refsByKey = new Map(
      threads.map((thread) => {
        const ref = scopeThreadRef(thread.environmentId, thread.id);
        return [scopedThreadKey(ref), ref] as const;
      }),
    );
    return Object.entries(draftThreadsByThreadKey).flatMap(([rawDraftId, draft]) => {
      const ref = refsByKey.get(
        scopedThreadKey(scopeThreadRef(draft.environmentId, draft.threadId)),
      );
      return ref === undefined ? [] : [{ draftId: DraftId.make(rawDraftId), threadRef: ref }];
    });
  }, [draftThreadsByThreadKey, threads]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      {changeRequestReporterGroups.map(([workspaceKey, group]) => (
        <BoardChangeRequestStateReporter
          key={workspaceKey}
          environmentId={group.environmentId}
          workspacePath={group.workspacePath}
          threads={group.threads}
          onChangeRequestState={handleChangeRequestState}
        />
      ))}
      {draftPromotionPairs.map((pair) => (
        <BoardDraftPromotionReconciler
          key={pair.draftId}
          draftId={pair.draftId}
          threadRef={pair.threadRef}
        />
      ))}
      <header
        className={cn(
          "flex min-h-12 shrink-0 items-center gap-2 border-b border-border py-2 pl-[calc(env(safe-area-inset-left)+0.5rem)] pr-[calc(env(safe-area-inset-right)+0.5rem)] transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:gap-3 sm:px-4 sm:py-2.5",
          COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
        )}
      >
        <h1 className="shrink-0 text-sm font-medium">
          <span className="sm:hidden">Board</span>
          <span className="hidden sm:inline">Session board</span>
        </h1>
        <p className="hidden text-xs text-muted-foreground/70 sm:block">
          Live sessions and drafts. Drag in Workflow columns to set a lane.
        </p>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <BoardOrganizationSelect
            label="Columns"
            value={organization.columns}
            items={[
              { value: "workflow", label: "Workflow" },
              { value: "state", label: "State" },
            ]}
            onValueChange={(value) => setOrganizationColumns(value as BoardOrganizationColumns)}
          />
          <BoardOrganizationSelect
            label="Rows"
            value={organization.rows}
            items={[
              { value: "project", label: "Project" },
              { value: "state", label: "State" },
              { value: "none", label: "None" },
            ]}
            onValueChange={(value) => setOrganizationRows(value as BoardOrganizationRows)}
          />
          {organization.columns === "workflow" ? (
            <NewLanePopover lanes={lanes} onCreate={handleCreateLane} />
          ) : null}
        </div>
      </header>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDraggingKey(null)}
      >
        {/*
          One board, not one per project. The lane header row and every group's
          cells share a single column grid, so a lane reads as one continuous
          column all the way down and project grouping is only a divider across
          it — the Linear scroll, rather than stacked mini-boards.
        */}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto">
          <div className="w-max min-w-full">
            <div
              data-board-lane-header-row
              className="sticky top-0 z-20 grid border-b border-border bg-background"
              style={{
                gridTemplateColumns: boardGridTemplateColumns,
                height: BOARD_HEADER_HEIGHT,
              }}
            >
              {boardColumns.map((column) => {
                const widthPx =
                  draggingLaneWidth?.key === column.key
                    ? draggingLaneWidth.widthPx
                    : selectBoardLaneWidth(laneWidthsByKey, column.key);
                const resizeProps = {
                  widthPx,
                  onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) =>
                    handleLaneResizePointerDown(column.key, widthPx, event),
                  onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) =>
                    handleLaneResizeKeyDown(column.key, widthPx, event),
                };
                return column.kind === "workflow" ? (
                  <LaneHeaderCell
                    key={column.key}
                    droppableId={boardLaneHeaderDroppableId(column.key)}
                    lane={column.lane}
                    lanes={lanes}
                    memberCount={laneMemberCountByKey.get(column.key) ?? 0}
                    {...resizeProps}
                    onUpdate={handleUpdateLane}
                    onReorder={handleReorderLane}
                    onArchive={handleArchiveLane}
                  />
                ) : (
                  <StateHeaderCell
                    key={column.key}
                    stateId={column.stateId}
                    label={column.label}
                    memberCount={laneMemberCountByKey.get(column.key) ?? 0}
                    {...resizeProps}
                  />
                );
              })}
            </div>

            {boardRows.map((row) => {
              const collapsed = collapsedProjectKeys.has(row.key);
              const byRowColumn = groupEntriesByLane(
                row.entries,
                boardColumns.map((column) => column.key),
              );
              const showRowHeader =
                row.grouping !== "none" &&
                !(row.grouping === "project" && projectScopeKey !== null);

              return (
                <Fragment key={row.key}>
                  {showRowHeader ? (
                    <div
                      // Opaque, not translucent: it sticks over live cards, and
                      // a blurred strip would repaint them on every scroll tick.
                      data-board-project-header
                      className="sticky z-10 flex w-full items-center border-b border-border/50 bg-muted hover:bg-accent"
                      style={{ top: BOARD_HEADER_HEIGHT }}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left"
                        onClick={() => toggleSwimlaneCollapsed(row.key)}
                      >
                        {collapsed ? (
                          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className="truncate text-xs font-medium">{row.label}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground/70">
                          {row.entryCount} {row.entryCount === 1 ? "card" : "cards"}
                        </span>
                      </button>
                      {row.grouping === "project" ? (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="mr-2 shrink-0"
                          aria-label={`New thread in ${row.label}`}
                          title={`New thread in ${row.label}`}
                          onClick={() => {
                            const projectRef = projectRefByGroupKey.get(row.value);
                            if (projectRef !== undefined) void handleNewThread(projectRef);
                          }}
                        >
                          <SquarePenIcon className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {collapsed && showRowHeader ? null : (
                    <div
                      className="grid"
                      style={{
                        gridTemplateColumns: boardGridTemplateColumns,
                      }}
                    >
                      {boardColumns.map((column) => (
                        <LaneDropCell
                          key={`${row.key}:${column.key}`}
                          droppableId={swimlaneColumnDroppableId(row.key, column.key)}
                          column={column}
                          lanes={lanes}
                          entries={byRowColumn.get(column.key) ?? []}
                          draggingKey={draggingKey}
                          draggable={organization.columns === "workflow"}
                          changeRequestStateForThread={changeRequestStateForThread}
                          onExpandDraft={(draftId) => setExpandedTarget({ kind: "draft", draftId })}
                          onDiscardDraft={clearDraftThread}
                        />
                      ))}
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        </div>
      </DndContext>
      {expandedTarget?.kind === "draft" && expandedDraft !== null ? (
        <BoardCardExpandedSheet
          target={{
            kind: "draft",
            draftId: expandedTarget.draftId,
            environmentId: expandedDraft.environmentId,
            threadId: expandedDraft.threadId,
            title: "New thread",
          }}
          open
          onOpenChange={(open) => {
            if (!open) setExpandedTarget(null);
          }}
        />
      ) : null}
    </SidebarInset>
  );
}

function BoardDraftPromotionReconciler(props: {
  readonly draftId: DraftId;
  readonly threadRef: ScopedThreadRef;
}) {
  const thread = useThreadDetail(props.threadRef);
  const expandedTarget = useBoardFocusStore((state) => state.expandedTarget);
  const setExpandedTarget = useBoardFocusStore((state) => state.setExpanded);

  useEffect(() => {
    markPromotedDraftThreadByRef(props.threadRef);
  }, [props.threadRef]);

  useEffect(() => {
    if (!threadHasStarted(thread)) return;
    if (expandedTarget?.kind === "draft" && expandedTarget.draftId === props.draftId) {
      setExpandedTarget({ kind: "thread", threadKey: scopedThreadKey(props.threadRef) });
    }
    finalizePromotedDraftThreadByRef(props.threadRef);
  }, [expandedTarget, props.draftId, props.threadRef, setExpandedTarget, thread]);

  return null;
}

function BoardOrganizationSelect(props: {
  readonly label: string;
  readonly value: string;
  readonly items: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly onValueChange: (value: string) => void;
}) {
  return (
    <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="hidden sm:inline">{props.label}</span>
      <Select
        value={props.value}
        items={props.items}
        onValueChange={(value) => {
          if (value !== null) props.onValueChange(value);
        }}
      >
        <SelectTrigger
          size="xs"
          className="w-20 sm:w-24"
          aria-label={`Board ${props.label.toLowerCase()}`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false} align="end">
          {props.items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </label>
  );
}

function NewLanePopover({
  lanes,
  onCreate,
}: {
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly onCreate: (draft: LaneDraft) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [order, setOrder] = useState(() => String(nextLaneOrder(lanes)));

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;
    setName("");
    setDescription("");
    setOrder(String(nextLaneOrder(lanes)));
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericOrder = Number(order);
    if (name.trim() === "" || description.trim() === "" || !Number.isFinite(numericOrder)) return;
    const created = await onCreate({
      name: name.trim(),
      description: description.trim(),
      order: numericOrder,
    });
    if (created) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button size="xs" variant="outline" aria-label="Create lane" className="shrink-0" />
        }
      >
        <PlusIcon className="size-3.5" />
        <span className="hidden sm:inline">New lane</span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-80">
        <form className="space-y-3" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-1">
            <PopoverTitle className="text-sm">Create lane</PopoverTitle>
            <PopoverDescription className="text-xs">
              Add an intent column to this board.
            </PopoverDescription>
          </div>
          <LaneFields
            name={name}
            description={description}
            order={order}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            onOrderChange={setOrder}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" size="xs">
              Create lane
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function LaneEditorPopover({
  lane,
  lanes,
  memberCount,
  onUpdate,
  onReorder,
  onArchive,
}: {
  readonly lane: BoardLane;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly memberCount: number;
  readonly onUpdate: (laneId: BoardLaneId, draft: LaneDraft) => Promise<boolean>;
  readonly onReorder: (laneId: BoardLaneId, direction: "up" | "down") => Promise<void>;
  readonly onArchive: (laneId: BoardLaneId, memberCount: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(lane.name);
  const [description, setDescription] = useState(lane.description);
  const [order, setOrder] = useState(String(lane.order));
  const canMoveUp = reorderLaneUpdates(lanes, lane.id, "up").length > 0;
  const canMoveDown = reorderLaneUpdates(lanes, lane.id, "down").length > 0;
  const canArchive = lanes.length > 1;

  useEffect(() => {
    setName(lane.name);
    setDescription(lane.description);
    setOrder(String(lane.order));
  }, [lane]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const numericOrder = Number(order);
    if (name.trim() === "" || description.trim() === "" || !Number.isFinite(numericOrder)) return;
    const updated = await onUpdate(lane.id, {
      name: name.trim(),
      description: description.trim(),
      order: numericOrder,
    });
    if (updated) setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label={`Manage ${lane.name} lane`} />}
      >
        <EllipsisIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <form className="space-y-3" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-1">
            <PopoverTitle className="text-sm">Manage lane</PopoverTitle>
            <PopoverDescription className="text-xs">Lane id: {lane.id}</PopoverDescription>
          </div>
          <LaneFields
            name={name}
            description={description}
            order={order}
            onNameChange={setName}
            onDescriptionChange={setDescription}
            onOrderChange={setOrder}
          />
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">Move column</span>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canMoveUp}
              onClick={() => void onReorder(lane.id, "up")}
            >
              Left
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!canMoveDown}
              onClick={() => void onReorder(lane.id, "down")}
            >
              Right
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
            <Button
              type="button"
              size="xs"
              variant="destructive-outline"
              disabled={!canArchive}
              title={canArchive ? undefined : "A board must keep at least one lane"}
              onClick={async () => {
                if (await onArchive(lane.id, memberCount)) setOpen(false);
              }}
            >
              Archive lane
            </Button>
            <Button type="submit" size="xs">
              Save changes
            </Button>
          </div>
        </form>
      </PopoverPopup>
    </Popover>
  );
}

function LaneFields({
  name,
  description,
  order,
  onNameChange,
  onDescriptionChange,
  onOrderChange,
}: {
  readonly name: string;
  readonly description: string;
  readonly order: string;
  readonly onNameChange: (value: string) => void;
  readonly onDescriptionChange: (value: string) => void;
  readonly onOrderChange: (value: string) => void;
}) {
  return (
    <div className="space-y-3">
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Name</span>
        <Input required value={name} onChange={(event) => onNameChange(event.target.value)} />
      </label>
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Description</span>
        <Textarea
          required
          size="sm"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
        <span className="block text-[11px] text-muted-foreground">
          This description helps you recognize where sessions belong on this board.
        </span>
      </label>
      <label className="block space-y-1 text-xs">
        <span className="font-medium">Order</span>
        <Input
          nativeInput
          required
          type="number"
          step="any"
          value={order}
          onChange={(event) => onOrderChange(event.target.value)}
        />
      </label>
    </div>
  );
}

/**
 * The single header for a lane. There is one per lane for the whole board, not
 * one per project group, so the count it shows is the lane's total.
 */
function StateHeaderCell(props: {
  readonly stateId: BoardStateId;
  readonly label: string;
  readonly memberCount: number;
  readonly widthPx: number;
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div
      data-board-state={props.stateId}
      className={cn(
        "relative flex min-w-0 flex-col justify-center px-3 py-2",
        BOARD_COLUMN_RULE_CLASS,
        (props.stateId === "snoozed" || props.stateId === "settled") &&
          "bg-muted/45 text-muted-foreground",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.label}</span>
        <span className="text-[11px] text-muted-foreground/70">{props.memberCount}</span>
      </div>
      <p className="truncate text-[11px] text-muted-foreground/60">Runtime presentation state</p>
      <LaneResizeHandle
        label={props.label}
        widthPx={props.widthPx}
        onPointerDown={props.onResizePointerDown}
        onKeyDown={props.onResizeKeyDown}
      />
    </div>
  );
}

function LaneResizeHandle(props: {
  readonly label: string;
  readonly widthPx: number;
  readonly onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={props.onPointerDown}
      onKeyDown={props.onKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${props.label} column. Use arrow keys to resize.`}
      aria-valuemin={BOARD_LANE_MIN_WIDTH}
      aria-valuemax={BOARD_LANE_MAX_WIDTH}
      aria-valuenow={props.widthPx}
      title={`Column width: ${props.widthPx}px`}
      className="group absolute inset-y-0 right-0 z-10 w-2 translate-x-1/2 cursor-ew-resize touch-none select-none border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:w-6"
    >
      <span className="pointer-events-none absolute inset-y-1 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-border group-active:bg-primary/60" />
    </button>
  );
}

function LaneHeaderCell({
  droppableId,
  lane,
  lanes,
  memberCount,
  widthPx,
  onResizePointerDown,
  onResizeKeyDown,
  onUpdate,
  onReorder,
  onArchive,
}: {
  readonly droppableId: string;
  readonly lane: BoardLane;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly memberCount: number;
  readonly widthPx: number;
  readonly onResizePointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  readonly onResizeKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  readonly onUpdate: (laneId: BoardLaneId, draft: LaneDraft) => Promise<boolean>;
  readonly onReorder: (laneId: BoardLaneId, direction: "up" | "down") => Promise<void>;
  readonly onArchive: (laneId: BoardLaneId, memberCount: number) => Promise<boolean>;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: droppableId });
  return (
    <div
      ref={setNodeRef}
      data-lane={lane.id}
      className={cn(
        "relative flex min-w-0 flex-col justify-center px-3 py-2",
        BOARD_COLUMN_RULE_CLASS,
        isOver && "bg-accent/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={lane.name}>
          {lane.name}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground/70">{memberCount}</span>
        {isBoardFixedLaneId(lane.id) ? null : (
          <LaneEditorPopover
            lane={lane}
            lanes={lanes}
            memberCount={memberCount}
            onUpdate={onUpdate}
            onReorder={onReorder}
            onArchive={onArchive}
          />
        )}
      </div>
      <p className="truncate text-[11px] text-muted-foreground/60" title={lane.description}>
        {lane.description}
      </p>
      <LaneResizeHandle
        label={lane.name}
        widthPx={widthPx}
        onPointerDown={onResizePointerDown}
        onKeyDown={onResizeKeyDown}
      />
    </div>
  );
}

/** One lane's slice of one project group: the drop target and its cards. */
function LaneDropCell({
  droppableId,
  column,
  lanes,
  entries,
  draggingKey,
  draggable,
  changeRequestStateForThread,
  onExpandDraft,
  onDiscardDraft,
}: {
  readonly droppableId: string;
  readonly column: BoardColumn;
  readonly lanes: ReadonlyArray<BoardLane>;
  readonly entries: ReadonlyArray<PlacedEntry>;
  readonly draggingKey: string | null;
  readonly draggable: boolean;
  readonly changeRequestStateForThread: (threadKey: string) => ChangeRequestStateLike | null;
  readonly onExpandDraft: (draftId: DraftId) => void;
  readonly onDiscardDraft: (draftId: DraftId) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: droppableId, disabled: !draggable });

  return (
    // Not a bounded scroll region: this cell sits in a content-sized grid row
    // inside the board's own scroller, so it never receives a height shorter
    // than its content.
    <div
      ref={setNodeRef}
      data-board-column={column.key}
      className={cn(
        "min-h-16 min-w-0 p-2",
        BOARD_COLUMN_RULE_CLASS,
        column.kind === "state" &&
          (column.stateId === "snoozed" || column.stateId === "settled") &&
          "bg-muted/25",
        isOver && "bg-accent/40",
      )}
    >
      <div
        className="grid min-w-0 justify-items-start gap-2"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))",
        }}
      >
        <SortableContext items={entries.map((entry) => entry.key)} strategy={rectSortingStrategy}>
          {entries.map((entry) => (
            <div key={entry.key} className="w-full max-w-[428px] min-w-0">
              {entry.kind === "thread" ? (
                <BoardSessionCard
                  cardKey={entry.key}
                  threadRef={entry.ref}
                  thread={entry.thread}
                  laneId={entry.laneId}
                  workflowLabel={boardLaneLabel(entry.workflowLaneId, lanes)}
                  boardStateId={entry.boardStateId}
                  boardStateLabel={BOARD_STATE_BY_ID[entry.boardStateId].label}
                  draggable={draggable}
                  lanes={lanes}
                  projectTitle={entry.projectTitle}
                  environmentLabel={entry.environmentLabel}
                  environmentConnection={entry.environmentConnection}
                  isDragging={draggingKey === entry.key}
                  changeRequestState={changeRequestStateForThread(entry.key)}
                />
              ) : (
                <BoardDraftCard
                  cardKey={entry.key}
                  draftId={entry.draftId}
                  title="Draft"
                  projectTitle={entry.projectTitle}
                  workflowLabel={boardLaneLabel(entry.workflowLaneId, lanes)}
                  boardStateLabel={BOARD_STATE_BY_ID.draft.label}
                  environmentLabel={entry.environmentLabel}
                  branch={entry.draft.branch}
                  draggable={draggable}
                  onExpand={onExpandDraft}
                  onDiscard={onDiscardDraft}
                />
              )}
            </div>
          ))}
        </SortableContext>
      </div>
    </div>
  );
}
