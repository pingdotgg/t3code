import type { EnvironmentId } from "@t3tools/contracts";

export function folderDropTarget(input: {
  localEnvironmentDisabled: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
}): "local" | "remote" {
  if (
    input.localEnvironmentDisabled ||
    input.primaryEnvironmentId === null ||
    input.environmentId !== input.primaryEnvironmentId
  ) {
    return "remote";
  }
  return "local";
}

export function resolveDroppedFolderPath(
  folder: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  const path = getPathForFile?.(folder);
  return typeof path === "string" && path.length > 0 ? path : null;
}
