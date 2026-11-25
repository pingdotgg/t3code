import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import {
  composerDraftHasUserContent,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { getClientSettings } from "../hooks/useSettings";
import { seedDraftModelSelection } from "./seedDraftModelSelection";

/** Moves an unsent draft with user content to `project`; false when there is nothing to move. */
export function moveDraftToProject(draftId: DraftId, project: EnvironmentProject): boolean {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  if (
    session === null ||
    session.promotedTo != null ||
    !composerDraftHasUserContent(store.getComposerDraft(draftId))
  ) {
    return false;
  }
  const projectRef = scopeProjectRef(project.environmentId, project.id);
  store.setLogicalProjectDraftThreadId(
    deriveLogicalProjectKeyFromSettings(
      project,
      selectProjectGroupingSettings(getClientSettings()),
    ),
    projectRef,
    draftId,
  );
  seedDraftModelSelection(draftId, projectRef);
  return true;
}
