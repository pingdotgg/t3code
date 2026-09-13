import { workspaceFileAssetResource as explicitWorkspaceFileAssetResource } from "@t3tools/client-runtime/workspace-file-asset-resource";
import type { AssetResource, ThreadId } from "@t3tools/contracts";
import {
  isAbsolutePath,
  isAudioPreviewFile,
  isVideoPreviewFile,
  resolveWorkspaceFilePath,
} from "./filePath";

/** An explicit tool/review root takes precedence over the conversation's current checkout. */
export function workspaceFileAssetResource(input: {
  readonly cwd: string | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
  readonly explicitCwd?: string | null;
}): AssetResource | null {
  if (input.cwd === null || input.relativePath === null) return null;
  if (input.explicitCwd != null) {
    return explicitWorkspaceFileAssetResource({ cwd: input.explicitCwd, path: input.relativePath });
  }
  if (input.threadId === null) return null;
  const path = resolveWorkspaceFilePath(input.cwd, input.relativePath);
  return {
    _tag:
      isVideoPreviewFile(path) || isAudioPreviewFile(path) || isAbsolutePath(input.relativePath)
        ? "media-file"
        : "workspace-file",
    threadId: input.threadId,
    path,
  };
}
