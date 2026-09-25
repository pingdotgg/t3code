import { useRouter } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/**
 * Removes a project whose clone never landed. The server clears the empty
 * folder along with the clone, so there is nothing to confirm: no threads
 * exist yet and the draft is the only thing lost, which the user is looking
 * at when they click.
 */
export function useRemoveClonedProject() {
  const router = useRouter();
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });

  return useCallback(
    async (projectRef: ScopedProjectRef) => {
      const draftStore = useComposerDraftStore.getState();
      const result = await deleteProject({
        environmentId: projectRef.environmentId,
        // Not forced: a project whose clone never landed has no threads, and
        // if one appeared in the meantime the server refuses rather than
        // silently deleting it.
        input: { projectId: projectRef.projectId },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to remove project",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return false;
      }
      // Read the route after the await: the user may have moved on while the
      // delete was in flight, and only a draft of this project needs to go.
      const routeParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const routeTarget = resolveThreadRouteTarget(routeParams);
      const viewingDraft =
        routeTarget?.kind === "draft" ? draftStore.getDraftSession(routeTarget.draftId) : null;
      const viewingThisProject =
        viewingDraft?.environmentId === projectRef.environmentId &&
        viewingDraft.projectId === projectRef.projectId;
      releaseProjectDraftUploads(projectRef);
      const projectDraft = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraft) draftStore.clearDraftThread(projectDraft.draftId);
      draftStore.clearProjectDraftThreadId(projectRef);
      if (viewingThisProject) void router.navigate({ to: "/", replace: true });
      return true;
    },
    [deleteProject, router],
  );
}
