import type { EnvironmentId } from "@t3tools/contracts";

export function folderDropTarget(input: {
  isElectron: boolean;
  localEnvironmentDisabled: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
}): "local" | "remote" | "browser" {
  if (!input.isElectron) return "browser";
  if (
    input.localEnvironmentDisabled ||
    input.primaryEnvironmentId === null ||
    input.environmentId !== input.primaryEnvironmentId
  ) {
    return "remote";
  }
  return "local";
}
