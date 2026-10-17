import type { ReactElement } from "react";
import { Sheet } from "../../components/ui/Sheet";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
}

export function WorktreeSetupSheet({ children, onClose }: WorktreeSetupSheetProps) {
  return (
    <Sheet prefersHorizontalBars title="Worktree setup" onClose={onClose}>
      {children}
    </Sheet>
  );
}
