import { type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime";
import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { toastManager } from "../ui/toast";
import { SidebarInset } from "../ui/sidebar";
import { useGridLayoutStore } from "../../gridLayoutStore";
import { selectThreadsForEnvironment, useStore } from "../../store";
import { useComposerDraftStore } from "../../composerDraftStore";
import { newDraftId, newThreadId } from "../../lib/utils";

import { GridPane } from "./GridPane";
import { GridToolbar } from "./GridToolbar";
import { cellIndexToCoord, populatedCellThreadKeys, type GridLayoutState } from "./gridLayout";

interface GridViewProps {
  environmentId: EnvironmentId;
}

export function GridView({ environmentId }: GridViewProps) {
  const layout = useGridLayoutStore((store) => store.getState(environmentId));
  const assignCell = useGridLayoutStore((store) => store.assignCell);
  const clearCell = useGridLayoutStore((store) => store.clearCell);
  const setSize = useGridLayoutStore((store) => store.setSize);
  const setFocusedCell = useGridLayoutStore((store) => store.setFocusedCell);
  const setActive = useGridLayoutStore((store) => store.setActive);
  const setLastView = useGridLayoutStore((store) => store.setLastView);
  const resetEnvironment = useGridLayoutStore((store) => store.resetEnvironment);

  useEffect(() => {
    setActive(environmentId, true);
    setLastView(environmentId, "grid");
    return () => {
      setActive(environmentId, false);
    };
  }, [environmentId, setActive, setLastView]);

  const serverThreads = useStore(
    useShallow((store) => selectThreadsForEnvironment(store, environmentId)),
  );
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);

  // Prune cells pointing to threads that have been archived or deleted.
  useEffect(() => {
    const aliveServerKeys = new Set(
      serverThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    );
    const draftSessionsByThreadKey = useComposerDraftStore.getState().draftThreadsByThreadKey;
    for (let index = 0; index < layout.cells.length; index += 1) {
      const cell = layout.cells[index];
      if (!cell || cell.threadKey === null) continue;
      const threadRef = parseScopedThreadKey(cell.threadKey);
      if (!threadRef) {
        clearCell(environmentId, index);
        continue;
      }
      if (threadRef.environmentId !== environmentId) continue;
      if (aliveServerKeys.has(cell.threadKey)) continue;
      const hasDraft = Object.values(draftSessionsByThreadKey).some(
        (draft) =>
          draft.environmentId === threadRef.environmentId && draft.threadId === threadRef.threadId,
      );
      if (!hasDraft) {
        clearCell(environmentId, index);
      }
    }
  }, [clearCell, environmentId, layout.cells, serverThreads]);

  const populatedThreadKeys = useMemo(() => populatedCellThreadKeys(layout), [layout]);
  const excludedThreadKeys = useMemo(() => new Set(populatedThreadKeys), [populatedThreadKeys]);

  const handleAssignThread = useCallback(
    (cellIndex: number, threadKey: string) => {
      assignCell(environmentId, cellIndex, threadKey);
      setFocusedCell(environmentId, cellIndex);
    },
    [assignCell, environmentId, setFocusedCell],
  );

  const handleClearCell = useCallback(
    (cellIndex: number) => {
      clearCell(environmentId, cellIndex);
    },
    [clearCell, environmentId],
  );

  const handleFocusCell = useCallback(
    (cellIndex: number) => {
      setFocusedCell(environmentId, cellIndex);
    },
    [environmentId, setFocusedCell],
  );

  const handleRequestNewThread = useCallback(
    (cellIndex: number) => {
      const envState = useStore.getState().environmentStateById[environmentId];
      const projectId = envState?.projectIds[0] as ProjectId | undefined;
      if (!projectId) {
        toastManager.add({
          type: "warning",
          title: "No project available",
          description: "Add a project to this environment before creating new grid threads.",
        });
        return;
      }
      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      const projectRef = scopeProjectRef(environmentId, projectId);
      // Each grid-created draft lives under its own unique logical-project mapping
      // so creating a new pane doesn't evict a sibling pane's draft via the
      // "one draft per logical project" deletion inside setLogicalProjectDraftThreadId.
      const gridLogicalProjectKey = `grid:${scopedProjectKey(projectRef)}:${draftId}`;
      setLogicalProjectDraftThreadId(gridLogicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt,
        envMode: "local",
      });
      applyStickyState(draftId);
      const threadKey = scopedThreadKey(scopeThreadRef(environmentId, threadId));
      assignCell(environmentId, cellIndex, threadKey);
      setFocusedCell(environmentId, cellIndex);
    },
    [applyStickyState, assignCell, environmentId, setFocusedCell, setLogicalProjectDraftThreadId],
  );

  const handleChangeSize = useCallback(
    (rows: number, cols: number) => {
      setSize(environmentId, rows, cols);
    },
    [environmentId, setSize],
  );

  const handleResetLayout = useCallback(() => {
    resetEnvironment(environmentId);
  }, [environmentId, resetEnvironment]);

  const compactness = resolveCompactness(layout.cols);
  const densityClass =
    compactness === "ultra" ? "scale-95" : compactness === "compact" ? "scale-100" : "scale-100";

  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${layout.rows}, minmax(0, 1fr))`,
  };

  const cells = layout.cells;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <GridToolbar
        environmentId={environmentId}
        rows={layout.rows}
        cols={layout.cols}
        populatedCount={populatedThreadKeys.length}
        totalCellCount={cells.length}
        onChangeSize={handleChangeSize}
        onResetLayout={handleResetLayout}
      />
      <div
        className="grid min-h-0 flex-1 gap-2 overflow-hidden p-2"
        style={gridStyle}
        role="grid"
        aria-label="Chat split grid"
        data-grid-view-root
      >
        {cells.map((cell, index) => {
          const coord = cellIndexToCoord(index, layout.cols);
          const paneKey = `r${coord.row}c${coord.col}`;
          return (
            <div
              key={paneKey}
              className="contents"
              data-grid-row={coord.row}
              data-grid-col={coord.col}
            >
              <GridPane
                cell={cell}
                cellIndex={index}
                environmentId={environmentId}
                focused={layout.focusedCellIndex === index}
                excludedThreadKeys={excludedThreadKeys}
                onFocus={handleFocusCell}
                onAssignThread={handleAssignThread}
                onClearCell={handleClearCell}
                onRequestNewThread={handleRequestNewThread}
                densityClass={densityClass}
                compactness={compactness}
              />
            </div>
          );
        })}
      </div>
    </SidebarInset>
  );
}

function resolveCompactness(cols: number): "normal" | "compact" | "ultra" {
  if (cols <= 2) return "normal";
  if (cols <= 4) return "compact";
  return "ultra";
}

/** Exposed for tests. */
export function _testableResolveCompactness(cols: number): "normal" | "compact" | "ultra" {
  return resolveCompactness(cols);
}

export type { GridLayoutState };
