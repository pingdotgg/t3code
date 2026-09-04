import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { isAbsolutePath, isVideoPreviewFile, resolveWorkspaceFilePath } from "./filePath";

export function useWorkspaceFileAssetUrlState(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
}) {
  const absolutePath = useMemo(
    () =>
      props.cwd !== null && props.relativePath !== null
        ? resolveWorkspaceFilePath(props.cwd, props.relativePath)
        : null,
    [props.cwd, props.relativePath],
  );

  // Videos stream from an exact-file URL, and so does anything outside the
  // workspace, where no workspace-scoped URL can exist.
  const relativePath = props.relativePath;
  const resource = useMemo<AssetResource | null>(
    () =>
      absolutePath !== null && relativePath !== null && props.threadId !== null
        ? {
            _tag:
              isVideoPreviewFile(absolutePath) || isAbsolutePath(relativePath)
                ? "media-file"
                : "workspace-file",
            threadId: props.threadId,
            path: absolutePath,
          }
        : null,
    [absolutePath, relativePath, props.threadId],
  );
  const state = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  return { ...state, resource, refresh };
}
