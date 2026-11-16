import {
  releaseComposerImagePreviewFile,
  retainComposerImagePreviewFile,
} from "./composerImagePreview";

export interface SentImageHandoff {
  readonly uri: string;
  readonly aspectRatio: number;
}

// A sent image's local pixels and shape, so the pending bubble and then the delivered copy open at
// their final size over pixels already on screen instead of a placeholder that later resizes.
// The server re-ids attachments into the thread, so delivered images match by message and position.
const MAX_ENTRIES = 64;
// An entry keeps a cached composer preview it points at alive after the composer lets go of it.
const images = new Map<string, { readonly image: SentImageHandoff; readonly holdsFile: boolean }>();

function forget(key: string) {
  const entry = images.get(key);
  if (entry === undefined) return;
  images.delete(key);
  if (entry.holdsFile) releaseComposerImagePreviewFile(entry.image.uri);
}

function remember(key: string, image: SentImageHandoff) {
  if (!Number.isFinite(image.aspectRatio) || image.aspectRatio <= 0) return;
  const holdsFile = retainComposerImagePreviewFile(image.uri);
  forget(key);
  images.set(key, { image, holdsFile });
  if (images.size > MAX_ENTRIES) forget(images.keys().next().value!);
}

export function rememberDraftImage(attachmentId: string, image: SentImageHandoff): void {
  remember(`draft:${attachmentId}`, image);
}

export function forgetDraftImage(attachmentId: string): void {
  forget(`draft:${attachmentId}`);
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
  )?.image;
}
