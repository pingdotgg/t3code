import { imageMimeType } from "@t3tools/shared/image";
import type { FilePreviewItem } from "../components/FilePreviewModal.types";
import { isFileBackedComposerAttachment, type DraftComposerAttachment } from "./composerImages";

export function composerImageGallery(
  attachments: readonly DraftComposerAttachment[],
): FilePreviewItem[] {
  return attachments.flatMap((attachment): FilePreviewItem[] => {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) return [];
    if (isFileBackedComposerAttachment(attachment)) {
      return [{ kind: "image", name: attachment.name, attachment }];
    }
    return attachment.type === "image"
      ? [{ kind: "image", name: attachment.name, uri: attachment.dataUrl ?? attachment.previewUri }]
      : [];
  });
}
