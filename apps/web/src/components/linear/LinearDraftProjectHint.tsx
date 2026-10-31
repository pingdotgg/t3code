import { useNavigate } from "@tanstack/react-router";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { FromMappingBadge } from "./LinearProjectSelect";

/**
 * Under a new-thread heading for a draft started from a Linear issue: whether the project came
 * from the Linear mapping, with a way to change that mapping.
 */
export function LinearDraftProjectHint({
  draftId,
  activeProjectId,
}: {
  readonly draftId: DraftId;
  readonly activeProjectId: string | null;
}) {
  const navigate = useNavigate();
  const launch = useComposerDraftStore(
    (state) => state.getDraftSession(draftId)?.linearIssue ?? null,
  );
  if (launch === null) return null;
  const fromMapping = launch.mappedProjectId !== null && launch.mappedProjectId === activeProjectId;
  return (
    <p className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <span>From {launch.identifier}</span>
      {fromMapping ? <FromMappingBadge /> : <span>No Linear mapping for this project</span>}
      <button
        type="button"
        onClick={() => void navigate({ to: "/settings/linear" })}
        className="pointer-events-auto cursor-pointer text-primary underline-offset-4 hover:underline"
      >
        Edit Linear mapping…
      </button>
    </p>
  );
}
