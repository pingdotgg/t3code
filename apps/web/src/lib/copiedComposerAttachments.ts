import type { EnvironmentId } from "@t3tools/contracts";

// Keep the latest copy's files alive after source removal, including preview URL revocation.
// Replacing the copy releases the previous files instead of accumulating draft attachments.
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
