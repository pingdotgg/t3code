import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import { useCallback, useMemo, useState } from "react";

import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { searchSidebarThreadsByTitle } from "../Sidebar.logic";
import { openCommandPalette } from "../../commandPaletteBus";
import { useBoardStore } from "../../boardStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useSnoozeWakeTick } from "../../hooks/useSnoozeWakeTick";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerProvidersAtom } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  BOARD_COLUMNS,
  isActiveBoardColumn,
  dropHintForIntent,
  partitionThreadsIntoBoardColumns,
  resolveDropIntent,
  type BoardColumnId,
  type BoardEnvironmentCapabilities,
  type BoardPartitionContext,
} from "./Board.logic";
import { BoardCard } from "./BoardCard";
import { BoardColumn } from "./BoardColumn";
import { BoardToolbar } from "./BoardToolbar";
import { useBoardCardActions } from "./boardActions";

const NO_CAPABILITIES: BoardEnvironmentCapabilities = {
  settlement: false,
  snooze: false,
  pinning: false,
};

interface DragState {
  readonly threadKey: string;
  readonly from: BoardColumnId;
}

export function BoardView() {
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const actions = useBoardCardActions();
  const handleNewThread = useNewThreadHandler();

  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  // now is quantized to the minute so effectiveSettled memoization doesn't
  // churn on every render; auto-settle thresholds are day-granular anyway.
  const nowMinute = useNowMinute();
  const snoozeWakeTick = useSnoozeWakeTick(
    useMemo(() => threads.map((thread) => thread.snoozedUntil), [threads]),
  );

  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const projectScopeKey = useBoardStore((state) => state.projectScopeKey);
  const providerScopeId = useBoardStore((state) => state.providerScopeId);
  const searchQuery = useBoardStore((state) => state.searchQuery);

  // PR states stream in per-card (cards own the VCS subscriptions); a merged
  // or closed PR auto-settles its thread on the next partition.
  const [changeRequestStateByKey, setChangeRequestStateByKey] = useState<
    ReadonlyMap<string, "open" | "closed" | "merged">
  >(() => new Map());
  const handleChangeRequestState = useCallback(
    (threadKey: string, state: "open" | "closed" | "merged" | null) => {
      setChangeRequestStateByKey((current) => {
        if ((current.get(threadKey) ?? null) === state) return current;
        const next = new Map(current);
        if (state === null) next.delete(threadKey);
        else next.set(threadKey, state);
        return next;
      });
    },
    [],
  );

  const [drag, setDrag] = useState<DragState | null>(null);

  const projectByKey = useMemo(
    () => new Map(projects.map((project) => [`${project.environmentId}:${project.id}`, project])),
    [projects],
  );
  const providerEntryByInstanceId = useMemo(
    () =>
      new Map(
        deriveProviderInstanceEntries(serverProviders).map(
          (entry) => [entry.instanceId as string, entry] as const,
        ),
      ),
    [serverProviders],
  );

  const capabilitiesFor = useCallback(
    (thread: SidebarThreadSummary): BoardEnvironmentCapabilities => {
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if (!capabilities) return NO_CAPABILITIES;
      return {
        settlement: capabilities.threadSettlement === true,
        snooze: capabilities.threadSnooze === true,
        pinning: capabilities.threadPinning === true,
      };
    },
    [serverConfigs],
  );

  const visibleThreads = useMemo(() => {
    const scoped = threads.filter((thread) => {
      if (
        projectScopeKey !== null &&
        `${thread.environmentId}:${thread.projectId}` !== projectScopeKey
      ) {
        return false;
      }
      if (providerScopeId !== null) {
        const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
        if (instanceId !== providerScopeId) return false;
      }
      return true;
    });
    return searchQuery.trim().length > 0
      ? searchSidebarThreadsByTitle(scoped, searchQuery)
      : scoped;
  }, [projectScopeKey, providerScopeId, searchQuery, threads]);

  const columns = useMemo(() => {
    const now = `${nowMinute}:00.000Z`;
    // Snooze classification uses a REAL clock, not the quantized minute: wake
    // times are second-precise and a woken thread must not linger for the
    // rest of the minute. snoozeWakeTick re-runs this memo at the boundary.
    void snoozeWakeTick;
    const context: BoardPartitionContext = {
      now,
      preciseNow: new Date().toISOString(),
      autoSettleAfterDays,
      capabilitiesFor,
      changeRequestStateFor: (thread) =>
        changeRequestStateByKey.get(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ) ?? null,
      // Unread is client-side only: a completion the user has not looked at
      // is what separates Review from Idle.
      lastVisitedAtFor: (thread) =>
        threadLastVisitedAtById[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
    };
    return partitionThreadsIntoBoardColumns(visibleThreads, context);
  }, [
    autoSettleAfterDays,
    capabilitiesFor,
    changeRequestStateByKey,
    nowMinute,
    snoozeWakeTick,
    threadLastVisitedAtById,
    visibleThreads,
  ]);

  const columnByThreadKey = useMemo(() => {
    const map = new Map<string, BoardColumnId>();
    for (const column of BOARD_COLUMNS) {
      for (const thread of columns[column.id]) {
        map.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), column.id);
      }
    }
    return map;
  }, [columns]);

  const draggedThread = useMemo(() => {
    if (drag === null) return null;
    const ref = parseScopedThreadKey(drag.threadKey);
    if (ref === null) return null;
    return (
      visibleThreads.find(
        (thread) => thread.environmentId === ref.environmentId && thread.id === ref.threadId,
      ) ?? null
    );
  }, [drag, visibleThreads]);

  const onNewThread = useCallback(() => {
    const projectGroupCount = projectByKey.size;
    if (projectGroupCount > 1) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    const only = [...projectByKey.values()][0];
    if (!only) {
      openCommandPalette({ open: "add-project" });
      return;
    }
    void handleNewThread({ environmentId: only.environmentId, projectId: only.id });
  }, [handleNewThread, projectByKey]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const data = event.active.data.current;
    if (!data) return;
    setDrag({ threadKey: String(data.threadKey), from: data.columnId as BoardColumnId });
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const active = drag;
      setDrag(null);
      if (active === null) return;
      const overColumnId = resolveOverColumnId(event, columnByThreadKey);
      if (overColumnId === null) return;
      const ref = parseScopedThreadKey(active.threadKey);
      if (ref === null) return;
      const thread = visibleThreads.find(
        (candidate) =>
          candidate.environmentId === ref.environmentId && candidate.id === ref.threadId,
      );
      if (!thread) return;

      const intent = resolveDropIntent({
        thread,
        from: active.from,
        to: overColumnId,
        capabilities: capabilitiesFor(thread),
        now: new Date().toISOString(),
      });
      switch (intent.kind) {
        case "settle":
          actions.settleThread(ref);
          return;
        case "unsettle":
          actions.unsettleThread(ref);
          return;
        case "snooze": {
          const [firstPreset] = actions.resolveSnoozePresets();
          if (firstPreset) actions.snoozeThread(ref, firstPreset.snoozedUntil);
          return;
        }
        case "unsnooze":
          actions.unsnoozeThread(ref);
          return;
        case "none":
          return;
      }
    },
    [actions, capabilitiesFor, columnByThreadKey, drag, visibleThreads],
  );

  if (!bootstrapped) {
    return null;
  }

  const projectOptions = [...projectByKey.entries()].map(([id, project]) => ({
    id,
    label: project.title,
  }));
  const providerOptions = [...providerEntryByInstanceId.values()].map((entry) => ({
    id: entry.instanceId as string,
    label: entry.displayName,
  }));

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <BoardToolbar
          projectOptions={projectOptions}
          providerOptions={providerOptions}
          visibleCount={visibleThreads.length}
          onNewThread={onNewThread}
        />

        {visibleThreads.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader className="max-w-md">
              <EmptyTitle className="text-foreground text-lg">Nothing on the board</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                {threads.length === 0
                  ? "Start a thread and it will show up here."
                  : "No thread matches the current filters."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={pointerWithin}
            onDragStart={handleDragStart}
            onDragCancel={() => setDrag(null)}
            onDragEnd={handleDragEnd}
          >
            <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-3 py-3 sm:px-5">
              {BOARD_COLUMNS.map((column) => {
                const columnThreads = columns[column.id];
                if (
                  (column.id === "done" || column.id === "snoozed") &&
                  columnThreads.length === 0 &&
                  !someEnvironmentSupports(column.id, serverConfigs)
                ) {
                  return null;
                }
                const intent =
                  draggedThread === null || drag === null
                    ? null
                    : resolveDropIntent({
                        thread: draggedThread,
                        from: drag.from,
                        to: column.id,
                        capabilities: capabilitiesFor(draggedThread),
                        now: new Date().toISOString(),
                      });
                const mergedActiveRegion =
                  drag !== null &&
                  !isActiveBoardColumn(drag.from) &&
                  isActiveBoardColumn(column.id);

                return (
                  <BoardColumn
                    key={column.id}
                    columnId={column.id}
                    label={column.label}
                    count={columnThreads.length}
                    dropIntent={intent}
                    dropHint={
                      intent === null || draggedThread === null
                        ? null
                        : mergedActiveRegion
                          ? "Return to active"
                          : dropHintForIntent({ intent, thread: draggedThread })
                    }
                    isMergedActiveRegion={mergedActiveRegion}
                    onNewThread={column.id === BOARD_COLUMNS[0].id ? onNewThread : undefined}
                  >
                    {columnThreads.map((thread) => {
                      const projectKey = `${thread.environmentId}:${thread.projectId}`;
                      const project = projectByKey.get(projectKey) ?? null;
                      const instanceId =
                        thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
                      const capabilities = capabilitiesFor(thread);
                      return (
                        <BoardCard
                          key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
                          thread={thread}
                          columnId={column.id}
                          projectTitle={project?.title ?? null}
                          projectCwd={project?.workspaceRoot ?? null}
                          providerEntry={providerEntryByInstanceId.get(instanceId) ?? null}
                          isRemote={
                            primaryEnvironmentId !== null &&
                            thread.environmentId !== primaryEnvironmentId
                          }
                          isActiveThread={false}
                          nowMs={Date.parse(`${nowMinute}:00.000Z`)}
                          settlementSupported={capabilities.settlement}
                          snoozeSupported={capabilities.snooze}
                          pinningSupported={capabilities.pinning}
                          actions={actions}
                          onChangeRequestState={handleChangeRequestState}
                        />
                      );
                    })}
                  </BoardColumn>
                );
              })}
            </div>
          </DndContext>
        )}
      </div>
    </SidebarInset>
  );
}

function resolveOverColumnId(
  event: DragEndEvent,
  columnByThreadKey: ReadonlyMap<string, BoardColumnId>,
): BoardColumnId | null {
  const overId = event.over?.id;
  if (overId === undefined) return null;
  const overIdString = String(overId);
  if (overIdString.startsWith("column:")) {
    return overIdString.slice("column:".length) as BoardColumnId;
  }
  // Dropped on another card: that card's column is the target.
  return columnByThreadKey.get(overIdString) ?? null;
}

function someEnvironmentSupports(
  columnId: "done" | "snoozed",
  serverConfigs: ReturnType<typeof useServerConfigs>,
): boolean {
  for (const config of serverConfigs.values()) {
    const capabilities = config.environment.capabilities;
    if (columnId === "done" && capabilities.threadSettlement === true) return true;
    if (columnId === "snoozed" && capabilities.threadSnooze === true) return true;
  }
  return false;
}
