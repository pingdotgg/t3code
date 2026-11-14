import type { ScopedThreadRef } from "@t3tools/contracts";
import type { DraftId } from "~/composerDraftStore";

export interface GitActionsControlProps {
  gitCwd: string | null;
  activeThreadRef: ScopedThreadRef | null;
  draftId?: DraftId;
  compact?: boolean;
  showActions?: boolean;
  showChanges?: boolean;
  onOpenChanges?: () => void;
}
