import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrl } from "../../state/assets";
import { resolveWorkspaceFilePath } from "./filePath";

export function useWorkspaceFileAssetUrl(props: {
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

  return useAssetUrl(
    props.environmentId,
    absolutePath !== null && props.threadId !== null
      ? {
          _tag: "workspace-file",
          threadId: props.threadId,
          path: absolutePath,
        }
      : null,
  );
}
