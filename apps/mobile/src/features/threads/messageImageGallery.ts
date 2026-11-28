import type { ChatAttachment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import type { FilePreviewItem } from "../../components/ui/FilePreviewModal.types";
import { remoteAttachmentImageSource } from "../../lib/filePreviewGallery";
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
    images.push(remoteAttachmentImageSource(context.environmentId, attachment.id, attachment));
  }
  for (const href of markdownImageSources(message.text)) {
    const preview = resolveMarkdownMediaPreview(href, { ...context, imageEmbed: true });
    if (preview?.kind === "image") images.push(preview.source);
  }
  return images;
}
