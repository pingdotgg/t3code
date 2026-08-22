import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrlState, type AssetUrlState } from "../../state/assets";
import { resolveWorkspaceFilePath } from "./filePath";

export function useWorkspaceFileAssetUrl(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
}): AssetUrlState {
  const absolutePath = useMemo(
    () =>
      props.cwd !== null && props.relativePath !== null
        ? resolveWorkspaceFilePath(props.cwd, props.relativePath)
        : null,
    [props.cwd, props.relativePath],
  );
  const resource = useMemo<AssetResource | null>(
    () =>
      absolutePath !== null && props.threadId !== null
        ? {
            _tag: "workspace-file",
            threadId: props.threadId,
            path: absolutePath,
          }
        : null,
    [absolutePath, props.threadId],
  );

  return useAssetUrlState(props.environmentId, resource);
}
