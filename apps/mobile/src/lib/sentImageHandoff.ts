export interface SentImageHandoff {
  readonly uri: string;
  readonly aspectRatio: number;
}

// A sent image's local pixels and shape, so the pending bubble and then the delivered copy open at
// their final size over pixels already on screen instead of a placeholder that later resizes.
// The server re-ids attachments into the thread, so delivered images match by message and position.
const MAX_ENTRIES = 64;
const images = new Map<string, SentImageHandoff>();

function remember(key: string, image: SentImageHandoff) {
  if (!Number.isFinite(image.aspectRatio) || image.aspectRatio <= 0) return;
  images.delete(key);
  images.set(key, image);
  if (images.size > MAX_ENTRIES) images.delete(images.keys().next().value!);
}

export function rememberDraftImage(attachmentId: string, image: SentImageHandoff): void {
  remember(`draft:${attachmentId}`, image);
}

export function rememberSentImage(messageId: string, index: number, image: SentImageHandoff): void {
  remember(`message:${messageId}:${index}`, image);
}

export function sentImageHandoff(
  messageId: string,
  index: number,
  draftAttachmentId?: string,
): SentImageHandoff | undefined {
  return (
    images.get(`message:${messageId}:${index}`) ??
    (draftAttachmentId === undefined ? undefined : images.get(`draft:${draftAttachmentId}`))
  );
}
