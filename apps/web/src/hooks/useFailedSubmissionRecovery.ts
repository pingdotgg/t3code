import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import { type ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { FailedSubmissionRecoverySnapshot } from "../failedSubmissionRecoveryStore";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { newDraftId, newThreadId } from "../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { primaryServerSettingsAtom } from "../state/server";
import { useProjects } from "../state/entities";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import { useClientSettings } from "./useSettings";

/**
 * Rebuilds one failed submission in a detached, unsent draft. Unlike the
 * ordinary new-thread command it intentionally does not reuse a saved draft,
 * carry a model selection, or copy branch/worktree state.
 */
export function useFailedSubmissionRecoveryHandler() {
  const navigate = useNavigate();
  const projects = useProjects();
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);

  return useCallback(
    async (projectRef: ScopedProjectRef, snapshot: FailedSubmissionRecoverySnapshot) => {
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const draftId = DraftId.make(newDraftId());
      const threadId = newThreadId();
      const envMode = primaryServerSettings.defaultThreadEnvMode;
      const startFromOrigin = resolveNewDraftStartFromOrigin({
        envMode,
        newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
      });
      const store = useComposerDraftStore.getState();

      // Complete the store handoff before navigating, so the destination
      // always mounts with a fully populated draft rather than a flash of an
      // empty composer.
      store.createDetachedDraftThread(logicalProjectKey, projectRef, draftId, {
        threadId,
        createdAt: new Date().toISOString(),
        envMode,
        startFromOrigin,
        runtimeMode: snapshot.runtimeMode,
        interactionMode: snapshot.interactionMode,
      });
      store.setPrompt(draftId, snapshot.prompt);
      store.addImages(draftId, [...snapshot.images]);
      store.setTerminalContexts(draftId, [...snapshot.terminalContexts]);
      store.setElementContexts(
        draftId,
        snapshot.elementContexts.map((context) => ({ ...context, threadId })),
      );
      store.setPreviewAnnotations(draftId, [...snapshot.previewAnnotations]);
      store.setReviewComments(draftId, [...snapshot.reviewComments]);

      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(draftId),
      });
    },
    [navigate, primaryServerSettings, projectGroupingSettings, projects],
  );
}
