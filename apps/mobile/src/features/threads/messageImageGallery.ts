import type { ChatAttachment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import type { FilePreviewItem } from "../../components/FilePreviewModal.types";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";

export function messageImageGallery(
  message: { readonly text: string; readonly attachments?: readonly ChatAttachment[] },
  context: {
    environmentId: EnvironmentId;
    threadId: ThreadId;
    workspaceRoot: string | null | undefined;
  },
): FilePreviewItem[] {
  const images: FilePreviewItem[] = [];
  for (const attachment of message.attachments ?? []) {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) continue;
    images.push({
      kind: "image",
      name: attachment.name,
      environmentId: context.environmentId,
      resource: {
        _tag: "attachment",
        attachmentId: attachment.id,
        fileName: attachment.name,
        mimeType: attachment.mimeType,
      },
    });
  }
  for (const href of markdownImageSources(message.text)) {
    const preview = resolveMarkdownMediaPreview(href, { ...context, imageEmbed: true });
    if (preview?.kind === "image") images.push(preview.source);
  }
  return images;
}
