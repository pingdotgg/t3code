import type { ReactNode } from "react";

export interface SheetProps {
  readonly title: string;
  readonly children: ReactNode;
  readonly onClose: () => void;
  /** Return true when Back was handled inside the sheet instead of dismissing it. */
  readonly onBack?: () => boolean;
  readonly onRequestClose?: () => void;
  /** Blocks the close button and the swipe, such as while a submit is in flight. */
  readonly dismissDisabled?: boolean;
}
