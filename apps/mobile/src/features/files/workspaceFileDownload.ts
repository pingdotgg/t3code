import type { AssetResource, ThreadId } from "@t3tools/contracts";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";

import { resolveWorkspaceFilePath } from "./filePath";

export function workspaceFileDownloadResource(input: {
  readonly cwd: string;
  readonly relativePath: string;
  readonly threadId: ThreadId | null;
}): AssetResource {
  return input.threadId !== null
    ? {
        _tag: "media-file",
        threadId: input.threadId,
        path: resolveWorkspaceFilePath(input.cwd, input.relativePath),
        disposition: "attachment",
      }
    : {
        _tag: "draft-workspace-file",
        cwd: input.cwd,
        path: input.relativePath,
        disposition: "attachment",
      };
}

export function workspaceFileDownloadMimeType(name: string): string {
  const extensionIndex = name.lastIndexOf(".");
  const extension = extensionIndex < 0 ? "" : name.slice(extensionIndex);
  return (
    (extension.length > 0 ? hostPreviewMimeTypeFromExtension(extension) : null) ??
    "application/octet-stream"
  );
}
