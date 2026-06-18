import { scopedThreadKey } from "@t3tools/client-runtime";
import type {
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  TerminalOpenInput,
  ThreadId,
} from "@t3tools/contracts";
import { nextTerminalId, resolveTerminalSessionLabel } from "@t3tools/shared/terminalLabels";
import { useCallback, useMemo } from "react";

import { readEnvironmentApi } from "../environmentApi";
import {
  type PanelContentKind,
  type PanelSlot,
  type PanelTab,
  selectThreadPanelLayout,
  usePanelLayoutStore,
} from "../panelLayoutStore";
import { useKnownTerminalSessions } from "../terminalSessionState";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import type { TerminalContextSelection } from "../lib/terminalContext";
import { DockSlot } from "../components/DockSlot";
import DiffPanel from "../components/DiffPanel";
import ThreadTerminalDrawer from "../components/ThreadTerminalDrawer";
import PlanSidebar from "../components/PlanSidebar";
import { PreviewPanel } from "../components/preview/PreviewPanel";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import type { ActivePlanState, LatestProposedPlanState } from "../session-logic";

type DockPanelInput = {
  threadRef: ScopedThreadRef | null;
  threadId: ThreadId | null;
  project: { cwd: string } | null;
  worktreePath: string | null;
  isServerThread: boolean;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  activePlan: ActivePlanState | null;
  activeProposedPlan: LatestProposedPlanState | null;
  timestampFormat: TimestampFormat;
  markdownCwd: string | undefined;
  workspaceRoot: string | undefined;
};

export function useThreadDockPanels(input: DockPanelInput) {
  const layout = usePanelLayoutStore((state) =>
    selectThreadPanelLayout(state.panelLayoutByThreadKey, input.threadRef),
  );
  const addTab = usePanelLayoutStore((state) => state.addTab);
  const closeTab = usePanelLayoutStore((state) => state.closeTab);
  const setActiveTab = usePanelLayoutStore((state) => state.setActiveTab);
  const setSlotOpen = usePanelLayoutStore((state) => state.setSlotOpen);
  const terminalUiState = useTerminalUiStateStore((state) =>
    selectThreadTerminalUiState(state.terminalUiStateByThreadKey, input.threadRef),
  );
  const newTerminal = useTerminalUiStateStore((state) => state.newTerminal);
  const setActiveTerminal = useTerminalUiStateStore((state) => state.setActiveTerminal);
  const setTerminalHeight = useTerminalUiStateStore((state) => state.setTerminalHeight);
  const knownTerminalSessions = useKnownTerminalSessions({
    environmentId: input.threadRef?.environmentId ?? null,
    threadId: input.threadId,
  });

  const knownTerminalIds = useMemo(
    () => knownTerminalSessions.map((session) => session.target.terminalId),
    [knownTerminalSessions],
  );
  const terminalLabelsById = useMemo(() => {
    const labels = new Map<string, string>();
    for (const session of knownTerminalSessions) {
      labels.set(
        session.target.terminalId,
        resolveTerminalSessionLabel(session.target.terminalId, session.state.summary),
      );
    }
    return labels;
  }, [knownTerminalSessions]);

  const addTerminal = useCallback(
    (slot: PanelSlot) => {
      if (!input.threadRef || !input.threadId || !input.project) return;
      const terminalId = nextTerminalId([
        ...new Set([...knownTerminalIds, ...terminalUiState.terminalIds]),
      ]);
      newTerminal(input.threadRef, terminalId);
      addTab(input.threadRef, slot, { kind: "terminal", terminalId });
      const api = readEnvironmentApi(input.threadRef.environmentId);
      const openInput: TerminalOpenInput = {
        threadId: input.threadId,
        terminalId,
        cwd: input.worktreePath ?? input.project.cwd,
        ...(input.worktreePath !== null ? { worktreePath: input.worktreePath } : {}),
      };
      void api?.terminal.open(openInput).catch(() => undefined);
    },
    [
      addTab,
      input.project,
      input.threadId,
      input.threadRef,
      input.worktreePath,
      knownTerminalIds,
      newTerminal,
      terminalUiState.terminalIds,
    ],
  );

  const addKind = useCallback(
    (slot: PanelSlot, kind: PanelContentKind) => {
      if (!input.threadRef) return;
      if (kind === "terminal") {
        addTerminal(slot);
        return;
      }
      addTab(input.threadRef, slot, { kind });
    },
    [addTab, addTerminal, input.threadRef],
  );

  const toggleTerminal = useCallback(() => {
    if (!input.threadRef) return;
    const hasTerminal = layout.bottom.tabs.some((tab) => tab.kind === "terminal");
    if (hasTerminal) {
      setSlotOpen(input.threadRef, "bottom", !layout.bottom.open);
    } else {
      addTerminal("bottom");
    }
  }, [addTerminal, input.threadRef, layout.bottom.open, layout.bottom.tabs, setSlotOpen]);

  const toggleDiff = useCallback(() => {
    if (!input.threadRef) return;
    const hasDiff = layout.right.tabs.some((tab) => tab.kind === "diff");
    if (hasDiff) {
      setSlotOpen(input.threadRef, "right", !layout.right.open);
    } else {
      addTab(input.threadRef, "right", { kind: "diff" });
    }
  }, [addTab, input.threadRef, layout.right.open, layout.right.tabs, setSlotOpen]);

  const toggleRightDock = useCallback(() => {
    if (!input.threadRef) return;
    if (layout.right.tabs.length === 0) {
      addTab(input.threadRef, "right", { kind: "diff" });
      return;
    }
    setSlotOpen(input.threadRef, "right", !layout.right.open);
  }, [addTab, input.threadRef, layout.right.open, layout.right.tabs.length, setSlotOpen]);

  const openTasks = useCallback(() => {
    if (!input.threadRef) return;
    addTab(input.threadRef, "right", { kind: "tasks" });
  }, [addTab, input.threadRef]);

  const toggleBrowser = useCallback(() => {
    if (!input.threadRef) return;
    const existing = layout.right.tabs.find((tab) => tab.kind === "browser");
    if (!existing) {
      addTab(input.threadRef, "right", { kind: "browser" });
      return;
    }
    if (layout.right.open && layout.right.activeTabId === existing.id) {
      setSlotOpen(input.threadRef, "right", false);
      return;
    }
    setActiveTab(input.threadRef, "right", existing.id);
    setSlotOpen(input.threadRef, "right", true);
  }, [
    addTab,
    input.threadRef,
    layout.right.activeTabId,
    layout.right.open,
    layout.right.tabs,
    setActiveTab,
    setSlotOpen,
  ]);

  const closeTerminal = useCallback(
    (terminalId: string) => {
      if (!input.threadRef || !input.threadId) return;
      const api = readEnvironmentApi(input.threadRef.environmentId);
      void api?.terminal
        .close({ threadId: input.threadId, terminalId, deleteHistory: true })
        .catch(() => undefined);
    },
    [input.threadId, input.threadRef],
  );

  const renderTab = useCallback(
    (tab: PanelTab, visible: boolean) => {
      if (!input.threadRef || !input.threadId) return null;
      if (tab.kind === "browser") {
        return <PreviewPanel mode="embedded" threadRef={input.threadRef} visible={visible} />;
      }
      if (tab.kind === "diff") {
        return <DiffPanel mode="inline" />;
      }
      if (tab.kind === "tasks") {
        return (
          <PlanSidebar
            label="Tasks"
            activePlan={input.activePlan}
            activeProposedPlan={input.activeProposedPlan}
            environmentId={input.threadRef.environmentId}
            threadRef={input.threadRef}
            onClose={() => undefined}
            markdownCwd={input.markdownCwd}
            timestampFormat={input.timestampFormat}
            workspaceRoot={input.workspaceRoot}
            mode="embedded"
          />
        );
      }
      if (tab.kind === "terminal") {
        if (!input.project) return null;
        const terminalId = tab.terminalId ?? terminalUiState.activeTerminalId;
        const terminalIds = terminalId ? [terminalId] : [];
        return (
          <ThreadTerminalDrawer
            mode="panel"
            threadRef={input.threadRef}
            threadId={input.threadId}
            cwd={input.worktreePath ?? input.project.cwd}
            worktreePath={input.worktreePath}
            visible={visible}
            height={terminalUiState.terminalHeight}
            terminalIds={terminalIds}
            activeTerminalId={terminalId}
            terminalGroups={terminalIds.map((id) => ({ id: `group-${id}`, terminalIds: [id] }))}
            activeTerminalGroupId={terminalId ? `group-${terminalId}` : ""}
            focusRequestId={0}
            onSplitTerminal={() => addTerminal("right")}
            onSplitTerminalVertical={() => addTerminal("right")}
            onNewTerminal={() => addTerminal("right")}
            onActiveTerminalChange={(id) => setActiveTerminal(input.threadRef!, id)}
            onCloseTerminal={closeTerminal}
            onHeightChange={(height) => setTerminalHeight(input.threadRef!, height)}
            onAddTerminalContext={input.onAddTerminalContext}
            keybindings={input.keybindings}
            embedded
            terminalLabelsById={terminalLabelsById}
          />
        );
      }
      return null;
    },
    [
      addTerminal,
      closeTerminal,
      input.activePlan,
      input.activeProposedPlan,
      input.keybindings,
      input.markdownCwd,
      input.onAddTerminalContext,
      input.project,
      input.threadId,
      input.threadRef,
      input.timestampFormat,
      input.workspaceRoot,
      input.worktreePath,
      setActiveTerminal,
      setTerminalHeight,
      terminalLabelsById,
      terminalUiState.activeTerminalId,
      terminalUiState.terminalHeight,
    ],
  );

  const renderSlot = useCallback(
    (slot: PanelSlot, options?: { reserveLeadingInset?: boolean }) => {
      if (!input.threadRef) return null;
      const slotState = layout[slot];
      const terminalLabelByTabId = new Map<string, string>();
      for (const tab of slotState.tabs) {
        if (tab.kind === "terminal" && tab.terminalId) {
          terminalLabelByTabId.set(tab.id, terminalLabelsById.get(tab.terminalId) ?? "Terminal");
        }
      }
      return (
        <DockSlot
          slot={slot}
          tabs={slotState.tabs}
          activeTabId={slotState.activeTabId}
          terminalLabelByTabId={terminalLabelByTabId}
          isKindAvailable={(kind) =>
            kind === "terminal" ||
            kind === "browser" ||
            kind === "tasks" ||
            (kind === "diff" && input.isServerThread && input.project !== null)
          }
          onAddTab={(kind) => addKind(slot, kind)}
          onSelectTab={(tabId) => setActiveTab(input.threadRef!, slot, tabId)}
          onCloseTab={(tabId) => closeTab(input.threadRef!, slot, tabId)}
          onClose={() => setSlotOpen(input.threadRef!, slot, false)}
          renderTab={renderTab}
          reserveToggleSpace={slot === "right"}
          {...(options?.reserveLeadingInset !== undefined
            ? { reserveLeadingInset: options.reserveLeadingInset }
            : {})}
        />
      );
    },
    [
      addKind,
      closeTab,
      input.isServerThread,
      input.project,
      input.threadRef,
      layout,
      renderTab,
      setActiveTab,
      setSlotOpen,
      terminalLabelsById,
    ],
  );

  const threadKey = input.threadRef ? scopedThreadKey(input.threadRef) : null;

  return {
    threadKey,
    bottomOpen: layout.bottom.open,
    rightOpen: layout.right.open,
    hasTerminalTab: layout.bottom.tabs.some((tab) => tab.kind === "terminal"),
    hasDiffTab: layout.right.tabs.some((tab) => tab.kind === "diff"),
    rightHasTabs: layout.right.tabs.length > 0,
    addTerminal,
    toggleTerminal,
    toggleDiff,
    toggleBrowser,
    toggleRightDock,
    openTasks,
    renderSlot,
  };
}
