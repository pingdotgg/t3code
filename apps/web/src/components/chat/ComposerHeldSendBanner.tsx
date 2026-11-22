import type { EnvironmentId } from "@t3tools/contracts";
import { msg, useGT } from "gt-react";

import {
  composerTargetKey,
  type ComposerThreadTarget,
  useComposerThreadDraft,
} from "../../composerDraftStore";
import { m, type MessageResolver } from "../../i18n/messages";
import { useAttachmentUploadStore } from "../../lib/attachmentUploadQueue";
import { formatAttachmentUploadProgress } from "../../lib/attachmentUploadState";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { usePreparingComposerImages } from "./preparingComposerImages";

export const HELD_COMPOSER_SEND_BANNER_ID = "held-composer-send";

function HeldComposerSendStatus({
  environmentId,
  draftTarget,
}: {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
}) {
  const gt = useGT();
  const targetKey = composerTargetKey(draftTarget);
  const preparingCount = usePreparingComposerImages(targetKey).length;
  const draft = useComposerThreadDraft(draftTarget);
  const uploadsByImageId = useAttachmentUploadStore((state) => state.uploadsByImageId);

  if (preparingCount > 0) {
    return gt(
      "{count, plural, one {Sending once image is ready} other {Sending once {count} images are ready}}",
      { count: preparingCount },
    );
  }

  const uploading: number[] = [];
  for (const attachment of [...draft.images, ...draft.files]) {
    const upload = uploadsByImageId[attachment.id];
    if (upload?.status === "uploading" && upload.environmentId === environmentId) {
      uploading.push(upload.progress);
    }
  }
  if (uploading.length > 0) {
    const averageProgress =
      uploading.reduce((sum, progress) => sum + progress, 0) / uploading.length;
    if (averageProgress > 0) {
      return gt(
        "{count, plural, one {Sending once upload finishes ({percent})} other {Sending once {count} uploads finish ({percent})}}",
        { count: uploading.length, percent: formatAttachmentUploadProgress(averageProgress) },
      );
    }
    return gt(
      "{count, plural, one {Sending once upload finishes} other {Sending once {count} uploads finish}}",
      { count: uploading.length },
    );
  }

  return gt("Sending message");
}

/** Shown while a send waits for image compression or attachment uploads to finish. */
export function heldComposerSendBannerItem(
  input: {
    readonly environmentId: EnvironmentId;
    readonly draftTarget: ComposerThreadTarget;
    readonly onCancel: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  return {
    id: HELD_COMPOSER_SEND_BANNER_ID,
    variant: "info",
    icon: <Spinner size="xs" aria-hidden="true" />,
    title: (
      <HeldComposerSendStatus environmentId={input.environmentId} draftTarget={input.draftTarget} />
    ),
    description: resolve(msg("Edit or press Esc to cancel")),
    actions: (
      <Button
        size="xs"
        variant="ghost"
        onPointerDown={(event) => event.preventDefault()}
        onClick={input.onCancel}
      >
        {resolve(msg("Cancel"))}
      </Button>
    ),
  };
}
