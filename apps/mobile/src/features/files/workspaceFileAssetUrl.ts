import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { workspaceFileAssetResource } from "./workspaceFileAssetResource";

export function useWorkspaceFileAssetUrlState(props: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly relativePath: string | null;
  readonly threadId: ThreadId | null;
  /** Explicit preview root for drafts, task files, or files opened from a member checkout. */
  readonly draftCwd?: string | null;
}) {
  const resource = useMemo(
    () =>
      workspaceFileAssetResource({
        cwd: props.cwd,
        relativePath: props.relativePath,
        threadId: props.threadId,
        explicitCwd: props.draftCwd,
      }),
    [props.cwd, props.relativePath, props.threadId, props.draftCwd],
  );
  const state = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  return { ...state, resource, refresh };
}
