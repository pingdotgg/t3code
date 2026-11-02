import type { EnvironmentId } from "@t3tools/contracts";

import type { RemoteOpenMode } from "../../remoteOpen";

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly desktopHomeEnvironmentId: EnvironmentId | null;
  readonly remoteOpenMode: RemoteOpenMode;
}): boolean {
  if (!input.activeProjectName) return false;
  if (
    input.activeThreadEnvironmentId === input.primaryEnvironmentId ||
    input.activeThreadEnvironmentId === input.desktopHomeEnvironmentId
  ) {
    return true;
  }
  return input.remoteOpenMode !== "local-exec";
}
