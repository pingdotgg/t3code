import type { FileDiffMetadata } from "@pierre/diffs";
import { buildFileDiffContentVersion, buildFileDiffIdentityKey } from "~/lib/diffRendering";

export function resolvePullRequestSelectionFile(
  files: ReadonlyArray<FileDiffMetadata>,
  anchor: { readonly fileKey: string; readonly contentVersion: number },
) {
  const file = files.find((candidate) => buildFileDiffIdentityKey(candidate) === anchor.fileKey);
  return file !== undefined && buildFileDiffContentVersion(file) === anchor.contentVersion
    ? file
    : undefined;
}
