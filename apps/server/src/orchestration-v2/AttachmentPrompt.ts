import { type ChatAttachment, isProviderSendTurnSupportedImageMimeType } from "@t3tools/contracts";

import { resolveAttachmentPath } from "../attachmentStore.ts";

export function isProviderNativeImageAttachment(attachment: ChatAttachment): boolean {
  return (
    attachment.type === "image" && isProviderSendTurnSupportedImageMimeType(attachment.mimeType)
  );
}

export function providerMessageTextWithAttachmentPaths(input: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly attachmentsDir: string;
}): string {
  const paths = input.attachments.flatMap((attachment) => {
    const path = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment,
    });
    return path === null
      ? []
      : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${path}]`];
  });
  return [input.text, paths.join("\n")].filter((part) => part.length > 0).join("\n\n");
}
