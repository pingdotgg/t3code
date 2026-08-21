import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import { FolderPlusIcon, InboxIcon, LayoutGridIcon, PlusIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import {
  DraftId,
  finalizePromotedDraftThreadByRef,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { isElectron } from "../../env";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useNowMinute } from "../../hooks/useNowMinute";
import { getProjectOrderKey, selectProjectGroupingSettings } from "../../logicalProject";
import { cn } from "../../lib/utils";
import { useSessionGridFocusStore } from "../../sessionGridFocusStore";
import { buildSidebarProjectSnapshots } from "../../sidebarProjectGrouping";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../../uiStateStore";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../../workspaceTitlebar";
import { orderItemsByPreferredIds } from "../Sidebar.logic";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SessionGridChangeRequestObserverGroup } from "./SessionGridChangeRequestObserver";
import type { SessionGridChangeRequestObservation } from "./SessionGridChangeRequestObserver";
import { SessionGridChatPane } from "./SessionGridChatPane";
import { SessionGridDraftPane } from "./SessionGridDraftPane";
import { SessionGridResizableLayout } from "./SessionGridResizableLayout";
import {
  buildSessionGridSections,
  resolveSessionGridArrowTargetIndex,
  resolveSessionGridChangeRequestState,
  resolveSessionGridDimensions,
  resolveSessionGridLifecycle,
  resolveSessionGridProject,
  sessionGridChangeRequestKey,
  stabilizeSessionGridThreadKeys,
  type SessionGridChangeRequestState,
} from "./sessionGrid.logic";

const MAX_QUIET_CHECKOUT_OBSERVERS = 6;
const MAX_QUIET_THREAD_OBSERVERS = 24;
function samePrStatus(
  left: SessionGridChangeRequestObservation["prStatus"],
  right: SessionGridChangeRequestObservation["prStatus"],
) {
  if (left === right) return true;
  if (left === null || right === null) return false;
  return (
    left.label === right.label &&
    left.colorClass === right.colorClass &&
    left.tooltip === right.tooltip &&
    left.url === right.url
  );
}

function focusAdjacentGridPane(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (
    event.key !== "ArrowLeft" &&
    event.key !== "ArrowRight" &&
    event.key !== "ArrowUp" &&
    event.key !== "ArrowDown"
  ) {
    return;
  }
  const target = event.target as HTMLElement;
  if (!target.matches("[data-session-grid-pane]")) return;
  const panes = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>("[data-session-grid-pane]"),
  );
  const currentIndex = panes.indexOf(target);
  if (currentIndex < 0) return;
  const columnCount = Number(event.currentTarget.dataset.sessionGridColumns) || 1;
  const nextIndex = resolveSessionGridArrowTargetIndex({
    key: event.key,
    currentIndex,
    columnCount,
    itemCount: panes.length,
  });
  if (nextIndex === null) return;
  event.preventDefault();
  panes[nextIndex]?.focus();
}

export interface SessionGridViewProps {
  readonly requestedProjectKey: string | null;
}

// fork: project session grid — the selected logical project owns one full-area
// matrix of live thread panes. Only visible panes subscribe to thread details.
export function SessionGridView({ requestedProjectKey }: SessionGridViewProps) {
  const navigate = useNavigate();
  const projects = useProjects();
  const threads = useThreadShells();
  const serverConfigs = useServerConfigs();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const projectOrder = useUiStateStore((state) => state.projectOrder);
  const sessionGridThreadOrderByProjectKey = useUiStateStore(
    (state) => state.sessionGridThreadOrderByProjectKey,
  );
  const setSessionGridThreadOrder = useUiStateStore((state) => state.setSessionGridThreadOrder);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const autoSettleOnMerge = useClientSettings((settings) => settings.sidebarAutoSettleOnMerge);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const nowMinute = useNowMinute();
  const wideGrid = useMediaQuery("md");
  const handleNewThread = useNewThreadHandler();
  const { settleThread, unsnoozeThread } = useThreadActions();
  const [changeRequestSnapshot, setChangeRequestSnapshot] = useState(() => ({
    stateByKey: new Map<string, SessionGridChangeRequestState>(),
    prStatusByKey: new Map<string, SessionGridChangeRequestObservation["prStatus"]>(),
  }));
  const [snoozeWakeTick, setSnoozeWakeTick] = useState(0);
  const [announcement, setAnnouncement] = useState({ id: 0, message: "" });
  const [focusedThreadKey, setFocusedThreadKey] = useState<string | null>(null);
  const [panelControlsPortalTarget, setPanelControlsPortalTarget] = useState<HTMLElement | null>(
    null,
  );
  const [rightPanelPortalTarget, setRightPanelPortalTarget] = useState<HTMLElement | null>(null);
  const [dragOverThreadKey, setDragOverThreadKey] = useState<string | null>(null);
  const draggedThreadKeyRef = useRef<string | null>(null);
  const pendingChangeRequestObservationsRef = useRef(
    new Map<string, SessionGridChangeRequestObservation>(),
  );
  const changeRequestFlushScheduledRef = useRef(false);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const environmentConnectionPhaseById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) => [environment.environmentId, environment.connection.phase] as const,
        ),
      ),
    [environments],
  );
  const environmentConnectionFingerprint = useMemo(
    () =>
      environments
        .map((environment) => `${environment.environmentId}\0${environment.connection.phase}`)
        .toSorted()
        .join("\0"),
    [environments],
  );
  const previousEnvironmentConnectionFingerprintRef = useRef(environmentConnectionFingerprint);
  const previousSelectedDraftItemKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (previousEnvironmentConnectionFingerprintRef.current === environmentConnectionFingerprint) {
      return;
    }
    previousEnvironmentConnectionFingerprintRef.current = environmentConnectionFingerprint;
    pendingChangeRequestObservationsRef.current.clear();
    setChangeRequestSnapshot({
      stateByKey: new Map<string, SessionGridChangeRequestState>(),
      prStatusByKey: new Map<string, SessionGridChangeRequestObservation["prStatus"]>(),
    });
  }, [environmentConnectionFingerprint]);

  const orderedProjects = useMemo(
    () =>
      orderItemsByPreferredIds({
        items: projects,
        preferredIds: projectOrder,
        getId: getProjectOrderKey,
        getPreferenceIds: (project) => [
          getProjectOrderKey(project),
          legacyProjectCwdPreferenceKey(project.workspaceRoot),
        ],
      }),
    [projectOrder, projects],
  );
  const projectGroups = useMemo(
    () =>
      buildSidebarProjectSnapshots({
        projects: orderedProjects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
        resolveEnvironmentLabel: (environmentId) => environmentLabelById.get(environmentId) ?? null,
      }),
    [environmentLabelById, orderedProjects, primaryEnvironmentId, projectGroupingSettings],
  );
  const projectByPhysicalKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
      ),
    [projects],
  );

  const preciseNow = useMemo(() => {
    void snoozeWakeTick;
    return new Date().toISOString();
  }, [nowMinute, snoozeWakeTick]);
  const lifecycle = useMemo(() => {
    const settledNow = `${nowMinute}:00.000Z`;
    const active: EnvironmentThreadShell[] = [];
    const snoozed: EnvironmentThreadShell[] = [];
    const pendingChangeRequest: EnvironmentThreadShell[] = [];

    for (const thread of threads) {
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const changeRequestKey = sessionGridChangeRequestKey({ threadKey, branch: thread.branch });
      const environmentConnected =
        environmentConnectionPhaseById.get(thread.environmentId) === "connected";
      const changeRequestState =
        thread.branch !== null && !environmentConnected
          ? "unknown"
          : resolveSessionGridChangeRequestState(
              changeRequestSnapshot.stateByKey,
              changeRequestKey,
              thread.branch,
            );
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      const state = resolveSessionGridLifecycle(thread, {
        preciseNow,
        settledNow,
        autoSettleAfterDays,
        autoSettleOnMerge,
        supportsSettlement: capabilities?.threadSettlement === true,
        supportsSnooze: capabilities?.threadSnooze === true,
        changeRequestState,
      });
      if (
        state === "active" &&
        environmentConnected &&
        thread.branch !== null &&
        !changeRequestSnapshot.stateByKey.has(changeRequestKey) &&
        resolveSessionGridLifecycle(thread, {
          preciseNow,
          settledNow,
          autoSettleAfterDays,
          autoSettleOnMerge,
          supportsSettlement: capabilities?.threadSettlement === true,
          supportsSnooze: capabilities?.threadSnooze === true,
          changeRequestState: null,
        }) === "settled"
      ) {
        pendingChangeRequest.push(thread);
        continue;
      }
      if (state === "active") active.push(thread);
      if (state === "snoozed") snoozed.push(thread);
    }
    return { active, snoozed, pendingChangeRequest };
  }, [
    autoSettleAfterDays,
    autoSettleOnMerge,
    changeRequestSnapshot.stateByKey,
    environmentConnectionPhaseById,
    nowMinute,
    preciseNow,
    serverConfigs,
    threads,
  ]);

  useEffect(() => {
    const nextWakeAtMs = lifecycle.snoozed.reduce((earliest, thread) => {
      const wakeAtMs = Date.parse(thread.snoozedUntil ?? "");
      return Number.isNaN(wakeAtMs) ? earliest : Math.min(earliest, wakeAtMs);
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(nextWakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const timeoutId = window.setTimeout(() => setSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [lifecycle.snoozed]);

  const gridModel = useMemo(
    () =>
      buildSessionGridSections({
        projects: projectGroups,
        activeThreads: lifecycle.active,
        snoozedThreads: lifecycle.snoozed,
        requestedProjectKey,
      }),
    [lifecycle.active, lifecycle.snoozed, projectGroups, requestedProjectKey],
  );
  const selectedProject = resolveSessionGridProject(projectGroups, gridModel.selectedProjectKey);
  const selectedDraftKey = useComposerDraftStore((store) =>
    gridModel.selectedProjectKey
      ? (store.logicalProjectDraftThreadKeyByLogicalProjectKey[gridModel.selectedProjectKey] ??
        null)
      : null,
  );
  const selectedDraft = useComposerDraftStore((store) =>
    selectedDraftKey ? (store.draftThreadsByThreadKey[selectedDraftKey] ?? null) : null,
  );
  const selectedDraftId = selectedDraftKey ? DraftId.make(selectedDraftKey) : null;
  const selectedDraftThreadKey = selectedDraft
    ? scopedThreadKey(scopeThreadRef(selectedDraft.environmentId, selectedDraft.threadId))
    : null;
  const selectedDraftItemKey = selectedDraftId ? `draft:${selectedDraftId}` : null;
  useEffect(() => {
    const previousDraftItemKey = previousSelectedDraftItemKeyRef.current;
    previousSelectedDraftItemKeyRef.current = selectedDraftItemKey;
    if (selectedDraftItemKey && selectedDraftItemKey !== previousDraftItemKey) {
      setFocusedThreadKey(selectedDraftItemKey);
    }
  }, [selectedDraftItemKey]);
  useEffect(() => {
    const store = useSessionGridFocusStore.getState();
    const draftFocused = focusedThreadKey !== null && focusedThreadKey === selectedDraftItemKey;
    store.setFocusedThreadKey(focusedThreadKey && !draftFocused ? focusedThreadKey : null);
    store.setFocusedDraftId(draftFocused ? selectedDraftId : null);
  }, [focusedThreadKey, selectedDraftId, selectedDraftItemKey]);
  useEffect(() => {
    useSessionGridFocusStore
      .getState()
      .setChangeRequestStateByKey(changeRequestSnapshot.stateByKey);
  }, [changeRequestSnapshot.stateByKey]);
  useEffect(
    () => () => {
      const store = useSessionGridFocusStore.getState();
      store.setFocusedThreadKey(null);
      store.setFocusedDraftId(null);
      store.setChangeRequestStateByKey(new Map());
    },
    [],
  );
  const selectedSection = gridModel.sections[0] ?? null;
  const selectedThreadKeys = useMemo(
    () =>
      (selectedSection?.threads ?? []).map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [selectedSection],
  );
  const preferredThreadKeys =
    gridModel.selectedProjectKey === null
      ? []
      : (sessionGridThreadOrderByProjectKey[gridModel.selectedProjectKey] ?? []);
  const orderedThreadKeys = useMemo(
    () => stabilizeSessionGridThreadKeys(preferredThreadKeys, selectedThreadKeys),
    [preferredThreadKeys, selectedThreadKeys],
  );
  const threadByKey = useMemo(
    () =>
      new Map(
        (selectedSection?.threads ?? []).map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [selectedSection],
  );
  const orderedThreads = useMemo(
    () => orderedThreadKeys.flatMap((key) => (threadByKey.get(key) ? [threadByKey.get(key)!] : [])),
    [orderedThreadKeys, threadByKey],
  );
  const visibleOrderedThreads = useMemo(
    () =>
      selectedDraftThreadKey === null
        ? orderedThreads
        : orderedThreads.filter(
            (thread) =>
              scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) !==
              selectedDraftThreadKey,
          ),
    [orderedThreads, selectedDraftThreadKey],
  );
  const visibleGridItemKeys = useMemo(
    () => [
      ...visibleOrderedThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
      ...(selectedDraftItemKey ? [selectedDraftItemKey] : []),
    ],
    [selectedDraftItemKey, visibleOrderedThreads],
  );
  const snoozedThreadKeys = useMemo(
    () =>
      new Set(
        (selectedSection?.snoozedThreads ?? []).map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [selectedSection],
  );

  useEffect(() => {
    if (gridModel.selectedProjectKey === null) return;
    if (
      preferredThreadKeys.length === orderedThreadKeys.length &&
      preferredThreadKeys.every((threadKey, index) => threadKey === orderedThreadKeys[index])
    ) {
      return;
    }
    setSessionGridThreadOrder(gridModel.selectedProjectKey, orderedThreadKeys);
  }, [
    gridModel.selectedProjectKey,
    orderedThreadKeys,
    preferredThreadKeys,
    setSessionGridThreadOrder,
  ]);

  useEffect(() => {
    if (visibleGridItemKeys.length === 0) {
      setFocusedThreadKey(null);
      return;
    }
    if (focusedThreadKey === null || !visibleGridItemKeys.includes(focusedThreadKey)) {
      setFocusedThreadKey(visibleGridItemKeys[0] ?? null);
    }
  }, [focusedThreadKey, visibleGridItemKeys]);

  const selectedProjectMemberKeys = useMemo(
    () =>
      new Set(
        selectedProject?.memberProjectRefs.map(
          (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
        ) ?? [],
      ),
    [selectedProject],
  );
  const visiblePendingChangeRequestCount = lifecycle.pendingChangeRequest.filter((thread) =>
    selectedProjectMemberKeys.has(`${thread.environmentId}:${thread.projectId}`),
  ).length;
  const pendingChangeRequestThreadKeys = useMemo(
    () =>
      new Set(
        lifecycle.pendingChangeRequest.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        ),
      ),
    [lifecycle.pendingChangeRequest],
  );
  const visibleThreadKeys = useMemo(() => new Set(orderedThreadKeys), [orderedThreadKeys]);
  const changeRequestObservationGroups = useMemo(() => {
    if (!bootstrapped) return [];
    const groups = new Map<
      string,
      {
        readonly key: string;
        readonly environmentId: EnvironmentThreadShell["environmentId"];
        readonly cwd: string;
        readonly threads: EnvironmentThreadShell[];
        readonly transient: boolean;
      }
    >();
    for (const thread of threads) {
      if (thread.archivedAt !== null || thread.branch === null) continue;
      if (environmentConnectionPhaseById.get(thread.environmentId) !== "connected") continue;
      const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const visible = visibleThreadKeys.has(threadKey);
      const pending = pendingChangeRequestThreadKeys.has(threadKey);
      if (!visible && !pending) continue;
      const project = projectByPhysicalKey.get(`${thread.environmentId}:${thread.projectId}`);
      const cwd = thread.worktreePath ?? project?.workspaceRoot ?? "";
      if (cwd.trim().length === 0) continue;
      const transient = !visible;
      const key = `${transient ? "quiet" : "visible"}\0${thread.environmentId}\0${cwd}`;
      const existing = groups.get(key);
      if (existing) existing.threads.push(thread);
      else
        groups.set(key, {
          key,
          environmentId: thread.environmentId,
          cwd,
          threads: [thread],
          transient,
        });
    }
    const allGroups = [...groups.values()];
    const quietGroups = allGroups
      .filter((group) => group.transient)
      .toSorted((left, right) => {
        const leftSelected = left.threads.some((thread) =>
          selectedProjectMemberKeys.has(`${thread.environmentId}:${thread.projectId}`),
        );
        const rightSelected = right.threads.some((thread) =>
          selectedProjectMemberKeys.has(`${thread.environmentId}:${thread.projectId}`),
        );
        if (leftSelected !== rightSelected) return leftSelected ? -1 : 1;
        const leftPrimary = left.environmentId === primaryEnvironmentId;
        const rightPrimary = right.environmentId === primaryEnvironmentId;
        if (leftPrimary !== rightPrimary) return leftPrimary ? -1 : 1;
        return left.key.localeCompare(right.key);
      });
    let quietThreadBudget = MAX_QUIET_THREAD_OBSERVERS;
    const boundedQuietGroups = quietGroups
      .slice(0, MAX_QUIET_CHECKOUT_OBSERVERS)
      .flatMap((group) => {
        if (quietThreadBudget <= 0) return [];
        const observedThreads = group.threads.slice(0, quietThreadBudget);
        quietThreadBudget -= observedThreads.length;
        return [{ ...group, threads: observedThreads }];
      });
    return [...allGroups.filter((group) => !group.transient), ...boundedQuietGroups];
  }, [
    bootstrapped,
    environmentConnectionPhaseById,
    pendingChangeRequestThreadKeys,
    primaryEnvironmentId,
    projectByPhysicalKey,
    selectedProjectMemberKeys,
    threads,
    visibleThreadKeys,
  ]);

  const reportChangeRequestState = useCallback(
    (observations: readonly SessionGridChangeRequestObservation[]) => {
      for (const observation of observations) {
        pendingChangeRequestObservationsRef.current.set(observation.key, observation);
      }
      if (changeRequestFlushScheduledRef.current) return;
      changeRequestFlushScheduledRef.current = true;
      queueMicrotask(() => {
        changeRequestFlushScheduledRef.current = false;
        const pending = [...pendingChangeRequestObservationsRef.current.values()];
        pendingChangeRequestObservationsRef.current.clear();
        setChangeRequestSnapshot((current) => {
          let stateByKey = current.stateByKey;
          let prStatusByKey = current.prStatusByKey;
          for (const observation of pending) {
            const stateChanged =
              !stateByKey.has(observation.key) ||
              stateByKey.get(observation.key) !== observation.state;
            const statusChanged = !samePrStatus(
              prStatusByKey.get(observation.key) ?? null,
              observation.prStatus,
            );
            if (!stateChanged && !statusChanged) continue;
            if (stateByKey === current.stateByKey) {
              stateByKey = new Map(current.stateByKey);
              prStatusByKey = new Map(current.prStatusByKey);
            }
            if (stateChanged) stateByKey.set(observation.key, observation.state);
            if (statusChanged) prStatusByKey.set(observation.key, observation.prStatus);
          }
          return stateByKey === current.stateByKey ? current : { stateByKey, prStatusByKey };
        });
      });
    },
    [],
  );

  const selectProject = useCallback(
    (projectKey: string, replace = false) =>
      navigate({ to: "/grid", search: { project: projectKey }, replace }),
    [navigate],
  );
  useEffect(() => {
    if (
      !bootstrapped ||
      gridModel.selectedProjectKey === null ||
      requestedProjectKey === gridModel.selectedProjectKey
    ) {
      return;
    }
    void selectProject(gridModel.selectedProjectKey, true);
  }, [bootstrapped, gridModel.selectedProjectKey, requestedProjectKey, selectProject]);

  const settle = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const result = await settleThread(scopeThreadRef(thread.environmentId, thread.id));
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to settle thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      }
      setAnnouncement((current) => ({ id: current.id + 1, message: `${thread.title} settled.` }));
      return true;
    },
    [settleThread],
  );
  const unsnooze = useCallback(
    async (thread: EnvironmentThreadShell) => {
      const result = await unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id));
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to wake thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        return false;
      }
      setAnnouncement((current) => ({
        id: current.id + 1,
        message: `${thread.title} returned to the active queue.`,
      }));
      return true;
    },
    [unsnoozeThread],
  );

  const createThreadInProject = useCallback(
    (project: (typeof projectGroups)[number]) => {
      void handleNewThread(scopeProjectRef(project.environmentId, project.id), {
        navigate: false,
      }).then(() => {
        const draft = useComposerDraftStore
          .getState()
          .getDraftSessionByLogicalProjectKey(project.projectKey);
        if (draft) {
          setFocusedThreadKey(`draft:${draft.draftId}`);
        }
      });
    },
    [handleNewThread],
  );
  const createThread = useCallback(() => {
    if (selectedProject) {
      createThreadInProject(selectedProject);
      return;
    }
    openCommandPalette({ open: projectGroups.length === 0 ? "add-project" : "new-thread-in" });
  }, [createThreadInProject, projectGroups.length, selectedProject]);

  const discardDraft = useCallback((draftId: DraftId) => {
    useComposerDraftStore.getState().clearDraftThread(draftId);
  }, []);
  const handleDraftPromoted = useCallback((threadRef: Parameters<typeof scopedThreadKey>[0]) => {
    setFocusedThreadKey(scopedThreadKey(threadRef));
    finalizePromotedDraftThreadByRef(threadRef);
  }, []);

  const reorderDraggedThread = useCallback(
    (targetThreadKey: string) => {
      const draggedThreadKey = draggedThreadKeyRef.current;
      const projectKey = gridModel.selectedProjectKey;
      if (!draggedThreadKey || !projectKey || draggedThreadKey === targetThreadKey) return;
      const next = [...orderedThreadKeys];
      const draggedIndex = next.indexOf(draggedThreadKey);
      const targetIndex = next.indexOf(targetThreadKey);
      if (draggedIndex < 0 || targetIndex < 0) return;
      next.splice(draggedIndex, 1);
      next.splice(targetIndex, 0, draggedThreadKey);
      setSessionGridThreadOrder(projectKey, next);
    },
    [gridModel.selectedProjectKey, orderedThreadKeys, setSessionGridThreadOrder],
  );
  const startThreadDrag = useCallback((threadKey: string, event: DragEvent<HTMLElement>) => {
    draggedThreadKeyRef.current = threadKey;
    setDragOverThreadKey(threadKey);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", threadKey);
  }, []);

  const selectedDraftProject = selectedDraft
    ? (projectByPhysicalKey.get(`${selectedDraft.environmentId}:${selectedDraft.projectId}`) ??
      null)
    : null;
  const visibleGridItemCount = visibleOrderedThreads.length + (selectedDraft ? 1 : 0);
  const dimensions = resolveSessionGridDimensions(visibleGridItemCount);
  const showNewThreadSlot =
    visibleGridItemCount > 0 && visibleGridItemCount < dimensions.columns * dimensions.rows;
  const visibleThreadCount = visibleGridItemCount;

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {changeRequestObservationGroups.map((group) => (
            <SessionGridChangeRequestObserverGroup
              cwd={group.cwd}
              environmentId={group.environmentId}
              key={group.key}
              onChangeRequestState={reportChangeRequestState}
              threads={group.threads}
              transient={group.transient}
            />
          ))}
          <span aria-live="polite" className="sr-only" role="status">
            <span key={announcement.id}>{announcement.message}</span>
          </span>

          <header
            className={cn(
              "workspace-topbar shrink-0 border-border/70 border-b bg-background transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none",
              isElectron
                ? "drag-region px-3 sm:px-5 wco:pr-[var(--workspace-native-controls-inset)]"
                : "pl-[calc(env(safe-area-inset-left)+0.75rem)] pr-[calc(env(safe-area-inset-right)+0.75rem)] sm:pl-[calc(env(safe-area-inset-left)+1.25rem)] sm:pr-[calc(env(safe-area-inset-right)+1.25rem)]",
              COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
            )}
          >
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <LayoutGridIcon className="size-4 shrink-0 text-muted-foreground" />
              <h1 className="text-sm font-semibold text-foreground">Session grid</h1>
              {selectedProject ? (
                <>
                  <span className="text-muted-foreground/55">/</span>
                  <span className="min-w-0 truncate text-xs text-muted-foreground">
                    {selectedProject.displayName}
                  </span>
                </>
              ) : null}
              <span className="hidden text-xs text-muted-foreground/70 sm:inline">
                {visibleThreadCount} open {visibleThreadCount === 1 ? "session" : "sessions"}
              </span>
              <div
                className="ml-auto flex h-full shrink-0 items-center"
                ref={setPanelControlsPortalTarget}
              />
              <Button
                aria-label="New thread"
                data-session-grid-primary-action
                onClick={createThread}
                size="sm"
              >
                <PlusIcon />
                <span className="hidden sm:inline">New thread</span>
              </Button>
            </div>
          </header>

          <main
            aria-busy={visiblePendingChangeRequestCount > 0}
            className="relative min-h-0 flex-1"
          >
            {!bootstrapped ? (
              <SessionGridLoading />
            ) : projects.length === 0 ? (
              <SessionGridEmpty
                actionLabel="Add project"
                description="Add a project to start a session and build its live grid."
                icon={FolderPlusIcon}
                onAction={() => openCommandPalette({ open: "add-project" })}
                title="No projects yet"
              />
            ) : visibleThreadCount === 0 && visiblePendingChangeRequestCount > 0 ? (
              <SessionGridChecking count={visiblePendingChangeRequestCount} />
            ) : visibleThreadCount === 0 ? (
              <SessionGridEmpty
                actionLabel="New thread"
                description={`There are no unsettled sessions in ${selectedProject?.displayName ?? "this project"}.`}
                icon={InboxIcon}
                onAction={createThread}
                title="No open sessions"
              />
            ) : (
              <DiffWorkerPoolProvider>
                <SessionGridResizableLayout
                  columns={dimensions.columns}
                  layoutKey={gridModel.selectedProjectKey ?? "unselected"}
                  onKeyDown={focusAdjacentGridPane}
                  resizable={wideGrid}
                  rows={dimensions.rows}
                >
                  {visibleOrderedThreads.map((thread) => {
                    const physicalProject = projectByPhysicalKey.get(
                      `${thread.environmentId}:${thread.projectId}`,
                    );
                    if (!physicalProject) return null;
                    const threadKey = scopedThreadKey(
                      scopeThreadRef(thread.environmentId, thread.id),
                    );
                    const showEnvironment =
                      selectedProject?.environmentPresence === "mixed" ||
                      thread.environmentId !== primaryEnvironmentId;
                    const changeRequestKey = sessionGridChangeRequestKey({
                      branch: thread.branch,
                      threadKey,
                    });
                    return (
                      <SessionGridChatPane
                        dragOver={dragOverThreadKey === threadKey}
                        environmentLabel={
                          showEnvironment
                            ? (environmentLabelById.get(thread.environmentId) ?? null)
                            : null
                        }
                        focused={focusedThreadKey === threadKey}
                        key={threadKey}
                        nowIso={preciseNow}
                        onDragEnd={() => {
                          draggedThreadKeyRef.current = null;
                          setDragOverThreadKey(null);
                        }}
                        onDragOver={setDragOverThreadKey}
                        onDragStart={startThreadDrag}
                        onDrop={(targetThreadKey) => {
                          reorderDraggedThread(targetThreadKey);
                          draggedThreadKeyRef.current = null;
                          setDragOverThreadKey(null);
                        }}
                        onFocus={setFocusedThreadKey}
                        onSettle={settle}
                        onUnsnooze={unsnooze}
                        panelControlsPortalTarget={panelControlsPortalTarget}
                        prStatus={changeRequestSnapshot.prStatusByKey.get(changeRequestKey) ?? null}
                        project={physicalProject}
                        rightPanelPortalTarget={rightPanelPortalTarget}
                        settlementSupported={
                          serverConfigs.get(thread.environmentId)?.environment.capabilities
                            .threadSettlement === true
                        }
                        snoozed={snoozedThreadKeys.has(threadKey)}
                        thread={thread}
                      />
                    );
                  })}
                  {selectedDraft &&
                  selectedDraftId &&
                  selectedDraftProject &&
                  selectedDraftItemKey ? (
                    <SessionGridDraftPane
                      draft={selectedDraft}
                      draftId={selectedDraftId}
                      environmentLabel={
                        selectedProject?.environmentPresence === "mixed" ||
                        selectedDraft.environmentId !== primaryEnvironmentId
                          ? (environmentLabelById.get(selectedDraft.environmentId) ?? null)
                          : null
                      }
                      focused={focusedThreadKey === selectedDraftItemKey}
                      key={selectedDraftId}
                      onDiscard={discardDraft}
                      onFocus={setFocusedThreadKey}
                      onPromoted={handleDraftPromoted}
                      panelControlsPortalTarget={panelControlsPortalTarget}
                      project={selectedDraftProject}
                      rightPanelPortalTarget={rightPanelPortalTarget}
                    />
                  ) : null}
                  {showNewThreadSlot ? (
                    <button
                      className="group/new-session flex min-h-0 min-w-0 items-center justify-center rounded-xl border border-dashed border-border bg-background/60 text-muted-foreground outline-none transition-colors hover:border-foreground/20 hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                      onClick={createThread}
                      type="button"
                    >
                      <span className="flex flex-col items-center gap-2 text-xs font-medium">
                        <span className="flex size-9 items-center justify-center rounded-full border border-dashed border-border bg-muted/20 transition-colors group-hover/new-session:border-foreground/25">
                          <PlusIcon className="size-4" />
                        </span>
                        New session
                      </span>
                    </button>
                  ) : null}
                </SessionGridResizableLayout>
                {visiblePendingChangeRequestCount > 0 ? (
                  <div
                    className="pointer-events-none absolute right-3 top-3 z-20 rounded-full border border-border/70 bg-background/90 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur-sm"
                    role="status"
                  >
                    Checking {visiblePendingChangeRequestCount} quiet session
                    {visiblePendingChangeRequestCount === 1 ? "" : "s"}…
                  </div>
                ) : null}
              </DiffWorkerPoolProvider>
            )}
          </main>
        </div>
        <div
          className="flex h-full min-h-0 shrink-0 overflow-hidden"
          data-session-grid-right-panel
          ref={setRightPanelPortalTarget}
        />
      </div>
    </SidebarInset>
  );
}

function SessionGridLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading session chats"
      className="grid h-full grid-cols-1 gap-3 bg-zinc-900 p-3 dark:bg-black sm:grid-cols-2 sm:grid-rows-2"
    >
      {Array.from({ length: 4 }, (_, index) => (
        <div
          className="flex min-h-72 flex-col overflow-hidden rounded-xl border bg-background"
          key={index}
        >
          <div className="flex h-11 items-center gap-2 border-border/70 border-b px-3">
            <Skeleton className="size-3.5 rounded-sm" />
            <Skeleton className="h-3 w-32" />
          </div>
          <div className="flex flex-1 items-center justify-center">
            <Skeleton className="h-16 w-3/5 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SessionGridChecking({ count }: { readonly count: number }) {
  return (
    <div className="flex h-full items-center justify-center px-6" role="status">
      <div className="max-w-md rounded-xl border border-border/65 bg-card px-6 py-7 text-center shadow-xs/5">
        <div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-xl border border-border/65 bg-muted/30 text-muted-foreground">
          <LayoutGridIcon className="size-4.5" />
        </div>
        <h2 className="text-sm font-semibold text-foreground">Checking quiet sessions</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Verifying pull request state for {count} branch {count === 1 ? "session" : "sessions"}.
        </p>
      </div>
    </div>
  );
}

function SessionGridEmpty(props: {
  readonly actionLabel: string;
  readonly description: string;
  readonly icon: typeof InboxIcon;
  readonly onAction: () => void;
  readonly title: string;
}) {
  const Icon = props.icon;
  return (
    <Empty className="h-full">
      <EmptyHeader className="max-w-md">
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription className="mt-2 leading-relaxed">{props.description}</EmptyDescription>
        <div className="mt-5">
          <Button onClick={props.onAction} size="sm">
            <PlusIcon />
            {props.actionLabel}
          </Button>
        </div>
      </EmptyHeader>
    </Empty>
  );
}
