import type { ReactNode } from "react";

export interface RowActionSlotProps {
  readonly children: ReactNode;
  /** The slot sits at a card's trailing edge. Android insets it; iOS does not. */
  readonly cardEdge?: boolean;
}
