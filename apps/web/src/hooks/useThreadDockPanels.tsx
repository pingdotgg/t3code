import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ResolvedKeybindingsConfig, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { Suspense, lazy } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { type TerminalContextSelection } from "~/lib/terminalContext";
import {
  type PanelContentKind,
  type PanelSlot,
  type PanelTab,
  selectThreadPanelLayout,
  usePanelLayoutStore,
} from "../panelLayoutStore";
import { useKnownTerminalSessions } from "../terminalSessionState";
import { DockSlot } from "../components/DockSlot";
import { SingleTerminalView } from "../components/SingleTerminalView";
import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";

const LazyDiffPanel = lazy(() => import("../components/DiffPanel"));

interface DockProject {
  cwd: string;
}

export interface UseThreadDockPanelsArgs {
  threadRef: ScopedThreadRef | null;
  threadId: ThreadId | null;
  project: DockProject | null;
  worktreePath: string | null;
  isServerThread: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

export interface ThreadDockPanels {
  bottomOpen: boolean;
  rightOpen: boolean;
  bottomSize: number;
  rightSize: number;
  hasTerminalTab: boolean;
  hasDiffTab: boolean;
  renderSlot: (slot: PanelSlot) => React.ReactNode;
  handleResize: (slot: PanelSlot, size: number) => void;
  toggleTerminal: () => void;
  toggleDiff: () => void;
  addTerminal: (slot?: PanelSlot) => void;
}

/**
 * Owns the active thread's dockable panel tabs: terminal session lifecycle
 * (one server terminal per terminal tab), diff tabs, tab reconciliation against
 * live sessions, and rendering of both slots. The terminal store stays
 * canonical for sessions; this hook only adds/removes tabs that reference them.
 */
export function useThreadDockPanels(args: UseThreadDockPanelsArgs): ThreadDockPanels {
  const { threadRef, threadId, project, worktreePath, isServerThread, keybindings } = args;
  const onAddTerminalContextRef = useRef(args.onAddTerminalContext);
  useEffect(() => {
    onAddTerminalContextRef.current = args.onAddTerminalContext;
  }, [args.onAddTerminalContext]);

  const panelLayout = usePanelLayoutStore((state) =>
    selectThreadPanelLayout(state.panelLayoutByThreadKey, threadRef),
  );
  const addTab = usePanelLayoutStore((state) => state.addTab);
  const closeTab = usePanelLayoutStore((state) => state.closeTab);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const setSlotOpen = usePanelLayoutStore((state) => state.setSlotOpen);
  const setSlotSize = usePanelLayoutStore((state) => state.setSlotSize);
  const reconcileTerminalTabs = usePanelLayoutStore((state) => state.reconcileTerminalTabs);

  const knownSessions = useKnownTerminalSessions({
    environmentId: threadRef?.environmentId ?? null,
    threadId,
  });
  const terminalLabelById = useMemo(() => {
    const next = new Map<string, string>();
    for (const session of knownSessions) {
      next.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return next;
  }, [knownSessions]);
  const validTerminalIds = useMemo(
    () => new Set(knownSessions.map((session) => session.target.terminalId)),
    [knownSessions],
  );

  // Terminal tabs added from the UI reference a session that opens
  // asynchronously. Until that session shows up in `validTerminalIds`, the tab
  // must not be reconciled away as "stale" — track those pending ids here.
  const pendingTerminalIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (pendingTerminalIdsRef.current.size === 0) return;
    for (const id of pendingTerminalIdsRef.current) {
      if (validTerminalIds.has(id)) {
        pendingTerminalIdsRef.current.delete(id);
      }
    }
  }, [validTerminalIds]);

  const cwd = useMemo(
    () => (project ? projectScriptCwd({ project: { cwd: project.cwd }, worktreePath }) : null),
    [project, worktreePath],
  );
  const runtimeEnv = useMemo(
    () => (project ? projectScriptRuntimeEnv({ project: { cwd: project.cwd }, worktreePath }) : {}),
    [project, worktreePath],
  );

  // Drop terminal tabs whose session has gone away (e.g. exited on the server).
  useEffect(() => {
    if (!threadRef) return;
    const allTerminalTabs = [...panelLayout.bottom.tabs, ...panelLayout.right.tabs].filter(
      (tab) => tab.kind === "terminal",
    );
    if (allTerminalTabs.length === 0) return;
    const hasStale = allTerminalTabs.some(
      (tab) =>
        !validTerminalIds.has(tab.terminalId ?? "") &&
        !pendingTerminalIdsRef.current.has(tab.terminalId ?? ""),
    );
    // Only reconcile once sessions are known; an empty set on first mount would
    // wrongly drop freshly-created tabs whose session is still opening. Tabs in
    // `pendingTerminalIdsRef` are newly added and excluded above.
    if (hasStale && validTerminalIds.size > 0) {
      reconcileTerminalTabs(threadRef, validTerminalIds);
    }
  }, [
    panelLayout.bottom.tabs,
    panelLayout.right.tabs,
    reconcileTerminalTabs,
    threadRef,
    validTerminalIds,
  ]);

  const openTerminalSession = useCallback(
    (terminalId: string) => {
      if (!threadRef || !threadId || !cwd) return;
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      void api.terminal
        .open({
          threadId,
          terminalId,
          cwd,
          ...(worktreePath != null ? { worktreePath } : {}),
          env: runtimeEnv,
        })
        .catch(() => undefined);
    },
    [cwd, runtimeEnv, threadId, threadRef, worktreePath],
  );

  const closeTerminalSession = useCallback(
    (terminalId: string) => {
      if (!threadRef || !threadId) return;
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void api.terminal
          .close({ threadId, terminalId, deleteHistory: true })
          .catch(() =>
            api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined),
          );
      } else {
        void api.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);
      }
    },
    [threadId, threadRef],
  );

  const isKindAvailable = useCallback(
    (kind: PanelContentKind) => {
      if (kind === "terminal") return project !== null && cwd !== null;
      if (kind === "diff") return isServerThread;
      return false;
    },
    [cwd, isServerThread, project],
  );

  const knownTerminalIds = useMemo(
    () => knownSessions.map((session) => session.target.terminalId),
    [knownSessions],
  );

  const handleAddTab = useCallback(
    (slot: PanelSlot, kind: PanelContentKind) => {
      if (!threadRef || !isKindAvailable(kind)) return;
      if (kind === "terminal") {
        const existingTerminalIds = [
          ...knownTerminalIds,
          ...panelLayout.bottom.tabs.map((tab) => tab.terminalId ?? ""),
          ...panelLayout.right.tabs.map((tab) => tab.terminalId ?? ""),
        ].filter((id) => id.length > 0);
        const terminalId = nextTerminalId(existingTerminalIds);
        // Mark as pending so the reconcile effect won't drop the tab before its
        // session opens; clear after a grace period so a session that never
        // opens can still be reconciled away.
        pendingTerminalIdsRef.current.add(terminalId);
        window.setTimeout(() => {
          pendingTerminalIdsRef.current.delete(terminalId);
        }, 10_000);
        addTab(threadRef, slot, { kind: "terminal", terminalId });
        openTerminalSession(terminalId);
        return;
      }
      addTab(threadRef, slot, { kind });
    },
    [
      addTab,
      isKindAvailable,
      knownTerminalIds,
      openTerminalSession,
      panelLayout.bottom.tabs,
      panelLayout.right.tabs,
      threadRef,
    ],
  );

  const handleCloseTab = useCallback(
    (slot: PanelSlot, tab: PanelTab) => {
      if (!threadRef) return;
      if (tab.kind === "terminal" && tab.terminalId) {
        closeTerminalSession(tab.terminalId);
      }
      closeTab(threadRef, slot, tab.id);
    },
    [closeTab, closeTerminalSession, threadRef],
  );

  const renderTabContent = useCallback(
    (slot: PanelSlot, tab: PanelTab, active: boolean) => {
      if (tab.kind === "terminal" && tab.terminalId && cwd && threadRef && threadId) {
        return (
          <SingleTerminalView
            threadRef={threadRef}
            threadId={threadId}
            terminalId={tab.terminalId}
            terminalLabel={terminalLabelById.get(tab.terminalId) ?? "Terminal"}
            cwd={cwd}
            {...(worktreePath !== undefined ? { worktreePath } : {})}
            runtimeEnv={runtimeEnv}
            active={active}
            focusRequestId={active ? 1 : 0}
            keybindings={keybindings}
            onSessionExited={() => handleCloseTab(slot, tab)}
            onAddTerminalContext={(selection) => onAddTerminalContextRef.current(selection)}
          />
        );
      }
      if (tab.kind === "diff") {
        return (
          <DiffWorkerPoolProvider>
            <Suspense fallback={null}>
              <LazyDiffPanel mode="panel" />
            </Suspense>
          </DiffWorkerPoolProvider>
        );
      }
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground/70">
          Coming soon
        </div>
      );
    },
    [
      cwd,
      handleCloseTab,
      keybindings,
      runtimeEnv,
      terminalLabelById,
      threadId,
      threadRef,
      worktreePath,
    ],
  );

  const renderSlot = useCallback(
    (slot: PanelSlot) => {
      const slotState = panelLayout[slot];
      const terminalLabelByTabId = new Map<string, string>();
      for (const tab of slotState.tabs) {
        if (tab.kind === "terminal" && tab.terminalId) {
          terminalLabelByTabId.set(tab.id, terminalLabelById.get(tab.terminalId) ?? "Terminal");
        }
      }
      return (
        <DockSlot
          slot={slot}
          tabs={slotState.tabs}
          activeTabId={slotState.activeTabId}
          terminalLabelByTabId={terminalLabelByTabId}
          isKindAvailable={isKindAvailable}
          onAddTab={(kind) => handleAddTab(slot, kind)}
          onSelectTab={(tabId) => threadRef && setActiveTab(threadRef, slot, tabId)}
          onCloseTab={(tabId) => {
            const tab = slotState.tabs.find((candidate) => candidate.id === tabId);
            if (tab) handleCloseTab(slot, tab);
          }}
          onClose={() => threadRef && setSlotOpen(threadRef, slot, false)}
          renderTab={(tab) => renderTabContent(slot, tab, tab.id === slotState.activeTabId)}
          reserveToggleSpace={slot === "right"}
        />
      );
    },
    [
      handleAddTab,
      handleCloseTab,
      isKindAvailable,
      panelLayout,
      renderTabContent,
      setActiveTab,
      setSlotOpen,
      terminalLabelById,
      threadRef,
    ],
  );

  const handleResize = useCallback(
    (slot: PanelSlot, size: number) => {
      if (!threadRef) return;
      setSlotSize(threadRef, slot, size);
    },
    [setSlotSize, threadRef],
  );

  const hasTerminalTab = useMemo(
    () =>
      [...panelLayout.bottom.tabs, ...panelLayout.right.tabs].some(
        (tab) => tab.kind === "terminal",
      ),
    [panelLayout.bottom.tabs, panelLayout.right.tabs],
  );
  const hasDiffTab = useMemo(
    () =>
      [...panelLayout.bottom.tabs, ...panelLayout.right.tabs].some((tab) => tab.kind === "diff"),
    [panelLayout.bottom.tabs, panelLayout.right.tabs],
  );

  // Toggling from the header acts on the bottom slot for terminals and the
  // right slot for diffs, matching where each kind lived before docking.
  const toggleTerminal = useCallback(() => {
    if (!threadRef) return;
    if (panelLayout.bottom.open) {
      setSlotOpen(threadRef, "bottom", false);
    } else if (panelLayout.bottom.tabs.length > 0) {
      setSlotOpen(threadRef, "bottom", true);
    } else {
      handleAddTab("bottom", "terminal");
    }
  }, [
    handleAddTab,
    panelLayout.bottom.open,
    panelLayout.bottom.tabs.length,
    setSlotOpen,
    threadRef,
  ]);

  const toggleDiff = useCallback(() => {
    if (!threadRef || !isServerThread) return;
    if (hasDiffTab && panelLayout.right.open) {
      setSlotOpen(threadRef, "right", false);
    } else {
      handleAddTab("right", "diff");
    }
  }, [handleAddTab, hasDiffTab, isServerThread, panelLayout.right.open, setSlotOpen, threadRef]);

  return {
    bottomOpen: panelLayout.bottom.open && panelLayout.bottom.tabs.length > 0,
    rightOpen: panelLayout.right.open && panelLayout.right.tabs.length > 0,
    bottomSize: panelLayout.bottom.size,
    rightSize: panelLayout.right.size,
    hasTerminalTab,
    hasDiffTab,
    renderSlot,
    handleResize,
    toggleTerminal,
    toggleDiff,
    addTerminal: (slot: PanelSlot = "bottom") => handleAddTab(slot, "terminal"),
  };
}

export type { ScopedThreadRef };
