import type { ReactNode } from "react";

export interface SheetProps {
  readonly title: string;
  readonly prefersHorizontalBars?: boolean;
  readonly children: ReactNode;
  readonly onClose: () => void;
}
