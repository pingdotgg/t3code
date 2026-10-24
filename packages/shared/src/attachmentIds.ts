const THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_SUFFIX =
  /^-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-z0-9]{1,10})?$/i;

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";

/** The thread part of every attachment id minted for `threadId`. */
export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ? "_pending" : segment;
}

/**
 * Whether `attachmentId` was minted for `threadId`. A thread segment can
 * itself hold dashes, so the rest of the id must be exactly the uuid and
 * optional extension that follow it.
 */
export function attachmentIdBelongsToThread(attachmentId: string, threadId: string): boolean {
  const segment = toSafeThreadAttachmentSegment(threadId);
  return (
    segment !== null &&
    attachmentId.toLowerCase().startsWith(segment) &&
    ATTACHMENT_ID_SUFFIX.test(attachmentId.slice(segment.length))
  );
}
