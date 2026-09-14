import { useNavigate, useParams } from "@tanstack/react-router";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useCallback } from "react";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

/**
 * Removes a project whose clone never landed. The server deletes the empty
 * folder along with the project entry, so there is nothing to confirm: no
 * threads exist yet and the draft is the only thing lost, which the user is
 * looking at when they click.
 */
export function useRemoveClonedProject() {
  const navigate = useNavigate();
  const { draftId: routeDraftId } = useParams({ strict: false });
  const deleteProject = useAtomCommand(projectEnvironment.delete, { reportFailure: false });

  return useCallback(
    async (projectRef: ScopedProjectRef) => {
      const draftStore = useComposerDraftStore.getState();
      const viewingDraft = routeDraftId
        ? draftStore.getDraftSession(routeDraftId as DraftId)
        : null;
      const viewingThisProject =
        viewingDraft?.environmentId === projectRef.environmentId &&
        viewingDraft.projectId === projectRef.projectId;
      const result = await deleteProject({
        environmentId: projectRef.environmentId,
        input: { projectId: projectRef.projectId, force: true },
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
      releaseProjectDraftUploads(projectRef);
      const projectDraft = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraft) draftStore.clearDraftThread(projectDraft.draftId);
      draftStore.clearProjectDraftThreadId(projectRef);
      if (viewingThisProject) void navigate({ to: "/", replace: true });
      return true;
    },
    [deleteProject, navigate, routeDraftId],
  );
}
