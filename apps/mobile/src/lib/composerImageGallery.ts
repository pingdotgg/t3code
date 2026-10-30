import { imageMimeType } from "@t3tools/shared/image";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FilePreviewItem } from "../components/FilePreviewModal.types";
import { isFileBackedComposerAttachment, type DraftComposerAttachment } from "./composerImages";

export function composerImageGallery(
  attachments: readonly DraftComposerAttachment[],
  environmentId?: EnvironmentId,
): FilePreviewItem[] {
  return attachments.flatMap((attachment): FilePreviewItem[] => {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) return [];
    if (environmentId !== undefined && attachment.uploadedAttachmentId) {
      return [
        {
          kind: "image",
          name: attachment.name,
          environmentId,
          resource: {
            _tag: "attachment",
            attachmentId: attachment.uploadedAttachmentId,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
        },
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
