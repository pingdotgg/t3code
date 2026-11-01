import type { ReactElement } from "react";
import { Sheet } from "../../components/ui/Sheet";

export interface WorktreeSetupSheetProps {
  children: ReactElement;
  height: number;
  onClose: () => void;
  /** Defaults to "Worktree setup". */
  title?: string;
}

export function WorktreeSetupSheet({
  children,
  onClose,
  title = "Worktree setup",
}: WorktreeSetupSheetProps) {
  return (
    <Sheet title={title} onClose={onClose}>
      {children}
    </Sheet>
  );
}
