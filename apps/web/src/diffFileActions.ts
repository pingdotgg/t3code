import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "./terminal-links";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): void {
  if (threadRef) {
    useRightPanelStore.getState().openFile(threadRef, filePath);
    return;
  }

  openInEditor(activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath);
}
