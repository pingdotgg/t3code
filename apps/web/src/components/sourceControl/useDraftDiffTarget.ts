/**
 * fork: f4 source-control panel — the draft-thread half of the diff surface.
 *
 * Thin store/atom wiring only; the rule it applies lives in
 * `~/lib/sourceControl/draftDiffTarget`, which documents the defect and is
 * tested without React.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  NO_DRAFT_DIFF_TARGET,
  resolveDraftDiffTarget,
  type DraftDiffTarget,
} from "~/lib/sourceControl/draftDiffTarget";
import { useProject } from "~/state/entities";

/**
 * Resolves a draft composer target to the ref/environment/cwd a file-scoped
 * diff needs. Everything is `null` for a server thread — the caller already has
 * better answers there — and for a draft whose project has not loaded yet.
 */
export function useDraftDiffTarget(target: ScopedThreadRef | DraftId | null): DraftDiffTarget {
  // `DraftId` is a branded string; a `ScopedThreadRef` is an object.
  const draftId = typeof target === "string" ? (target as DraftId) : null;
  const draft = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const project = useProject(
    draft === null ? null : scopeProjectRef(draft.environmentId, draft.projectId),
  );
  return useMemo(
    () => (draft === null ? NO_DRAFT_DIFF_TARGET : resolveDraftDiffTarget(draft, project)),
    [draft, project],
  );
}
