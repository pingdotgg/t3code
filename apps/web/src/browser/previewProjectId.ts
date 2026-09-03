import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useThreadShell } from "~/state/entities";

/**
 * Server shells win. Drafts keep a projectId before the orchestration shell
 * exists, so preview partitions can still mount on a local draft thread.
 */
export function resolvePreviewProjectId(
  shellProjectId: ProjectId | null | undefined,
  draftProjectId: ProjectId | null | undefined,
): ProjectId | null {
  return shellProjectId ?? draftProjectId ?? null;
}

export function usePreviewProjectId(threadRef: ScopedThreadRef): ProjectId | null {
  const threadShell = useThreadShell(threadRef);
  const draftProjectId = useComposerDraftStore(
    (store) => store.getDraftThreadByRef(threadRef)?.projectId ?? null,
  );
  return resolvePreviewProjectId(threadShell?.projectId, draftProjectId);
}
