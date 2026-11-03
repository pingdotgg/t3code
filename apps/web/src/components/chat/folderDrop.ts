import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";

export function folderDropTarget(input: {
  localEnvironmentDisabled: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
  connection: Pick<PreparedConnection, "target" | "httpBaseUrl"> | null;
  isDesktopRenderer: boolean;
}): "local" | "remote" {
  if (
    !input.localEnvironmentDisabled &&
    input.primaryEnvironmentId !== null &&
    input.environmentId === input.primaryEnvironmentId
  ) {
    return "local";
  }
  return input.isDesktopRenderer &&
    input.connection !== null &&
    isSavedLoopbackConnection(input.connection)
    ? "local"
    : "remote";
}

// A direct saved connection to loopback shares the desktop's filesystem; WSL backends and SSH forwards do not.
function isSavedLoopbackConnection({
  target,
  httpBaseUrl,
}: Pick<PreparedConnection, "target" | "httpBaseUrl">): boolean {
  if (target._tag !== "BearerConnectionTarget" || isDesktopLocalConnectionTarget(target)) {
    return false;
  }
  try {
    return isLoopbackHostname(new URL(httpBaseUrl).hostname);
  } catch {
    return false;
  }
}

export function resolveDroppedFolderPath(
  folder: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  const path = getPathForFile?.(folder);
  return typeof path === "string" && path.length > 0 ? path : null;
}
