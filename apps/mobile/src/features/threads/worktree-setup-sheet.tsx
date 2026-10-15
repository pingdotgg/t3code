import type { ReactElement } from "react";
import { Sheet } from "../../components/Sheet";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, onClose }: WorktreeSetupSheetProps) {
  return (
    <Sheet title="Worktree setup" onClose={onClose}>
      {children}
    </Sheet>
  );
}
