import type { ReactNode } from "react";

export interface WindowCoverProps {
  /** Covers the window, above every native sheet. */
  readonly visible: boolean;
  /**
   * Covers the window only to keep the app switcher snapshot private. Platforms whose snapshot
   * JavaScript cannot reach in time ignore it.
   */
  readonly obscured: boolean;
  readonly children: ReactNode;
}
