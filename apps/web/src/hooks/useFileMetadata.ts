import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { normalizeProjectPathForComparison, isAbsolutePath } from "@t3tools/shared/path";
import { useContext } from "react";

import { useEnvironmentScope } from "../state/session";
import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { FileMetadataThreadContext } from "./FileMetadataThreadProvider";

export function useFileMetadata(
  environmentId: EnvironmentId | null | undefined,
  path: string,
  cwd?: string,
) {
  const canRead = useEnvironmentScope(environmentId ?? null, AuthFilesystemReadScope);
  const threadRef = useContext(FileMetadataThreadContext);
  const hostPath = splitFilePathPosition(path).path;
  const targetPath = normalizeProjectPathForComparison(
    hostPath.startsWith("~/") || !cwd ? hostPath : resolvePathLinkTarget(hostPath, cwd),
  );
  const absolute = isAbsolutePath(targetPath) || targetPath.startsWith("~/");
  return useEnvironmentQuery(
    environmentId && canRead && absolute && targetPath.length <= 512
      ? projectEnvironment.fileMetadata({
          environmentId,
          input: {
            path: targetPath,
            ...(threadRef?.environmentId === environmentId ? { threadId: threadRef.threadId } : {}),
          },
        })
      : null,
  ).data;
}
