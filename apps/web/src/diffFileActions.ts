import type { ScopedThreadRef } from "@t3tools/contracts";

import { useRightPanelStore } from "./rightPanelStore";
import { resolvePathLinkTarget } from "./terminal-links";

interface OpenDiffFilePrimaryActionInput {
  readonly threadRef: ScopedThreadRef | null;
  readonly filePath: string;
  readonly activeCwd: string | undefined;
  // Owning repo root in a multi-repo diff, so the preview reads `filePath`
  // against that repo instead of the workspace anchor (#923). Undefined =
  // single-repo / anchor.
  readonly repoRoot?: string | undefined;
  readonly openInEditor: (targetPath: string) => void;
}

export function openDiffFilePrimaryAction({
  threadRef,
  filePath,
  activeCwd,
  repoRoot,
  openInEditor,
}: OpenDiffFilePrimaryActionInput): void {
  if (threadRef) {
    useRightPanelStore.getState().openFile(threadRef, filePath, undefined, repoRoot);
    return;
  }

  openInEditor(activeCwd ? resolvePathLinkTarget(filePath, activeCwd) : filePath);
}
