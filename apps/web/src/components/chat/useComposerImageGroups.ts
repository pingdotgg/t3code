import { type ComposerImageAttachment, type DraftId } from "../../composerDraftStore";
import { type ScopedThreadRef } from "@t3tools/contracts";
import {
  getPendingSnapShotAnimations,
  pendingSnapShotAnimationIdsForTarget,
  subscribeToPendingSnapShotAnimations,
} from "../../lib/snapShotAnimation";
import { useSyncExternalStore } from "react";

/**
 * Follows the SnapShots still animating into this draft and splits the draft's images into
 * pending SnapShots and standalone images.
 */
export function useComposerImageGroups(
  composerDraftTarget: ScopedThreadRef | DraftId,
  composerImages: ReadonlyArray<ComposerImageAttachment>,
  composerPreviewAnnotations: ReadonlyArray<{ readonly id: string }>,
) {
  const pendingSnapShotAnimations = useSyncExternalStore(
    subscribeToPendingSnapShotAnimations,
    getPendingSnapShotAnimations,
    getPendingSnapShotAnimations,
  );
  const pendingSnapShotIds = pendingSnapShotAnimationIdsForTarget(
    pendingSnapShotAnimations,
    composerDraftTarget,
  );
  const previewAnnotationIds = new Set(
    composerPreviewAnnotations.map((annotation) => annotation.id),
  );
  return {
    pendingSnapShotAnimations,
    pendingSnapShotIds,
    pendingSnapShotIdSet: new Set(pendingSnapShotIds),
    uncommittedSnapShotIds: pendingSnapShotIds.filter(
      (id) => !composerImages.some((image) => image.id === id),
    ),
    standaloneComposerImages: composerImages.filter((image) => !previewAnnotationIds.has(image.id)),
  };
}
