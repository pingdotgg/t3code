import type { EnvironmentId } from "@t3tools/contracts";
import { isSafeImageFileName } from "@t3tools/shared/imageMime";

import { resolveEnvironmentHttpUrl } from "./environments/runtime";

export const WORKSPACE_IMAGE_ROUTE_PATH = "/api/workspace-image";
export const WORKSPACE_GIT_IMAGE_ROUTE_PATH = "/api/workspace-git-image";
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{7,64}$/i;

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return isSafeImageFileName(path);
}

export function resolveWorkspaceImagePreviewUrl(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
}): string | null {
  if (!isWorkspaceImagePreviewPath(input.relativePath)) {
    return null;
  }
  try {
    return resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: WORKSPACE_IMAGE_ROUTE_PATH,
      searchParams: {
        cwd: input.cwd,
        relativePath: input.relativePath,
      },
    });
  } catch {
    return null;
  }
}

export function resolveWorkspaceGitImagePreviewUrl(input: {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  objectId: string | undefined;
}): string | null {
  const objectId = input.objectId?.trim();
  if (
    !isWorkspaceImagePreviewPath(input.relativePath) ||
    !objectId ||
    !GIT_OBJECT_ID_PATTERN.test(objectId) ||
    /^0+$/.test(objectId)
  ) {
    return null;
  }
  try {
    return resolveEnvironmentHttpUrl({
      environmentId: input.environmentId,
      pathname: WORKSPACE_GIT_IMAGE_ROUTE_PATH,
      searchParams: {
        cwd: input.cwd,
        relativePath: input.relativePath,
        objectId,
      },
    });
  } catch {
    return null;
  }
}
