import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Bytes behind the attachment records of this client's latest composer copy, keyed by the
 * `attachmentId` each record carries. A paste on the same client reads them here instead of
 * downloading from the source environment, so it still works when the source upload has not
 * finished, or was already released because the source draft was sent, cleared, or edited.
 * Pastes from another client or device fall back to the source environment's asset URL.
 * Only the latest copy is kept, which bounds the memory held after the source draft lets go.
 */
let latestCopy: { environmentId: EnvironmentId; files: ReadonlyMap<string, File> } | null = null;

export function rememberCopiedComposerAttachments(
  environmentId: EnvironmentId,
  files: ReadonlyMap<string, File>,
): void {
  latestCopy = files.size > 0 ? { environmentId, files } : null;
}

export function copiedComposerAttachmentFile(
  environmentId: EnvironmentId,
  attachmentId: string,
): File | undefined {
  return latestCopy?.environmentId === environmentId
    ? latestCopy.files.get(attachmentId)
    : undefined;
}
