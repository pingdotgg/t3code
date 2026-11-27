import { imageMimeType } from "@t3tools/shared/image";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FilePreviewItem } from "../components/ui/FilePreviewModal.types";
import { isFileBackedComposerAttachment, type DraftComposerAttachment } from "./composerImages";
import { remoteAttachmentImageSource } from "./filePreviewGallery";

export function composerImageGallery(
  attachments: readonly DraftComposerAttachment[],
  environmentId?: EnvironmentId,
): FilePreviewItem[] {
  return attachments.flatMap((attachment): FilePreviewItem[] => {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) return [];
    if (environmentId !== undefined && attachment.uploadedAttachmentId) {
      return [
        remoteAttachmentImageSource(environmentId, attachment.uploadedAttachmentId, attachment),
      ];
    }
    if (isFileBackedComposerAttachment(attachment)) {
      return [{ kind: "image", name: attachment.name, attachment }];
    }
    return attachment.type === "image"
      ? [{ kind: "image", name: attachment.name, uri: attachment.dataUrl ?? attachment.previewUri }]
      : [];
  });
}
