import { createContext } from "react";

export interface PaneContextValue {
  /** The pane the route follows; the others leave global focus and shortcuts to it. */
  readonly focused: boolean;
  /** Touches the window's top-left, where the collapsed-sidebar toggle and traffic lights sit. */
  readonly topLeading: boolean;
  /** Touches the window's top-right, where native window controls sit. */
  readonly topTrailing: boolean;
  /** Slot in the grid, for moving this pane by dragging. */
  readonly index: number;
  readonly onClose: () => void;
}

/** Set for each ChatView in a split view; null in the ordinary single view. */
export const PaneContext = createContext<PaneContextValue | null>(null);
