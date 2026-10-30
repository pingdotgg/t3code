const THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_SUFFIX =
  /^-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[a-z0-9]{1,10})?$/i;

export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";

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

/** Thread segments can hold dashes, so everything after the segment must be exactly the uuid and extension. */
export function attachmentIdBelongsToThread(attachmentId: string, threadId: string): boolean {
  const segment = toSafeThreadAttachmentSegment(threadId);
  return (
    segment !== null &&
    attachmentId.toLowerCase().startsWith(segment) &&
    ATTACHMENT_ID_SUFFIX.test(attachmentId.slice(segment.length))
  );
}
