/**
 * React context used by GridPane to coordinate with the ChatView it renders.
 *
 * When inside a grid pane:
 *   - ChatHeader swaps the "open grid split view" button for a × close-pane
 *     button; the × calls `onClosePane` which clears the grid cell.
 *   - ChatView routes diff toggles through `onRequestDiff` so the diff opens
 *     as a pane-local sheet instead of navigating away from the grid.
 *   - `diffOpen` reflects whether the pane-local diff sheet is currently open.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { TurnId } from "@t3tools/contracts";

export interface GridPaneDiffRequest {
  /** When true, open the diff. When false, close it. */
  open: boolean;
  /** Scope the diff to a single turn. */
  turnId?: TurnId;
  /** Scope the diff to a single file within the turn. */
  filePath?: string;
}

export interface GridPaneContextValue {
  readonly inGridPane: true;
  readonly onClosePane: () => void;
  readonly onRequestDiff: (request: GridPaneDiffRequest) => void;
  readonly diffOpen: boolean;
}

const GridPaneContext = createContext<GridPaneContextValue | null>(null);

export function GridPaneProvider({
  onClosePane,
  onRequestDiff,
  diffOpen,
  children,
}: {
  onClosePane: () => void;
  onRequestDiff: (request: GridPaneDiffRequest) => void;
  diffOpen: boolean;
  children: ReactNode;
}) {
  const value = useMemo<GridPaneContextValue>(
    () => ({ inGridPane: true, onClosePane, onRequestDiff, diffOpen }),
    [onClosePane, onRequestDiff, diffOpen],
  );
  return <GridPaneContext.Provider value={value}>{children}</GridPaneContext.Provider>;
}

export function useGridPaneContext(): GridPaneContextValue | null {
  return useContext(GridPaneContext);
}
