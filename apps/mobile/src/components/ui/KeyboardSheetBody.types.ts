import type { ReactNode } from "react";

export interface KeyboardSheetBodyProps {
  readonly children: ReactNode;
  /** A row of actions that rides the keyboard, such as attach and send. */
  readonly toolbar?: ReactNode;
}
