import type { ReactNode } from "react";

export interface SheetPaneProps {
  /** The iOS surface under the bar: a sheet's, or the screen's where the pane sits in a column. */
  readonly surface?: "sheet" | "screen";
  readonly children: ReactNode;
}
