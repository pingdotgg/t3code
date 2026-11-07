import type { EnvironmentId } from "@t3tools/contracts";

import type { RemoteOpenMode } from "../../remoteOpen";

export function shouldShowOpenInPicker(input: {
  readonly environmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  if (input.primaryEnvironmentId === null) return true;
  if (input.environmentId === input.primaryEnvironmentId) {
    return true;
  }
  return input.remoteOpenMode !== "local-exec";
}
