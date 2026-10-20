import type { ReactElement } from "react";
import { Sheet } from "../../components/ui/Sheet";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  title: string;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, onClose, title }: WorktreeSetupSheetProps) {
  return (
    <Sheet title={title} onClose={onClose}>
      {children}
    </Sheet>
  );
}
