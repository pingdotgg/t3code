import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

export interface DraftPipelineSelection {
  readonly environmentId: EnvironmentId;
  readonly pipelineId: string;
}

// Kept per draft, outside the screen, so the choice survives the composer remounting
// (split-view column changes, project or environment pickers) like the draft text does.
export const draftPipelineSelectionAtom = Atom.family((draftKey: string) =>
  Atom.make<DraftPipelineSelection | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel(`mobile:draft-pipeline-selection:${draftKey}`),
  ),
);
export const NO_DRAFT_PIPELINE_SELECTION_ATOM = Atom.make<DraftPipelineSelection | null>(null);

/**
 * The pipeline chosen for a draft in `environmentId`, or null. Pipelines live on one server, so a
 * choice made before the draft moved to another environment no longer applies. The id is
 * independent of whether the pipeline list has loaded: a draft that chose a pipeline must never
 * silently start a normal thread while the list is empty after a reconnect.
 */
export function activeDraftPipelineId(
  selection: DraftPipelineSelection | null,
  environmentId: EnvironmentId | null,
): string | null {
  return selection !== null && environmentId !== null && selection.environmentId === environmentId
    ? selection.pipelineId
    : null;
}
