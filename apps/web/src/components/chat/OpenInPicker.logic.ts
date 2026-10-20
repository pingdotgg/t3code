import type { EnvironmentId } from "@t3tools/contracts";

import type { RemoteOpenMode } from "../../remoteOpen";

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly localMachineEnvironmentId: EnvironmentId | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  if (!input.activeProjectName) return false;
  if (
    input.localMachineEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.localMachineEnvironmentId
  ) {
    return true;
  }
  return input.remoteOpenMode !== "local-exec";
}
