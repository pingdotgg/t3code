import type { ComposerContextRecord, EnvironmentId } from "@lathe/contracts";
import { imageMimeType } from "@lathe/shared/image";
import type { FilePreviewItem } from "../components/ui/FilePreviewModal.types";
import { composerImageGallery } from "./composerImageGallery";
import type { DraftComposerAttachment } from "./composerImages";

export function contextImageGallery(
  records: readonly ComposerContextRecord[],
  attachments: readonly DraftComposerAttachment[],
  environmentId?: EnvironmentId,
): FilePreviewItem[] {
  return records.flatMap((record): FilePreviewItem[] => {
    if (!("attachmentId" in record) || (record.kind !== "image" && imageMimeType(record) === null))
      return [];
    const local = attachments.find((item) => item.id === record.attachmentId);
    if (local) return composerImageGallery([local]);
    return environmentId
      ? [
          {
            kind: "image",
            name: record.name,
            environmentId,
            resource: {
              _tag: "attachment",
              attachmentId: record.attachmentId,
              fileName: record.name,
              mimeType: record.mimeType,
            },
          },
        ]
      : [];
  });
}
