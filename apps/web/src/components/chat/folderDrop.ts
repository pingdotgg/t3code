import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { PRIMARY_LOCAL_ENVIRONMENT_ID, type EnvironmentId } from "@t3tools/contracts";

import { desktopLocalBackendId, isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";

export type FolderDropTarget = "local" | "remote" | { readonly wslBackendId: string };

export function folderDropTarget(input: {
  localEnvironmentDisabled: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
  connection: Pick<PreparedConnection, "target" | "httpBaseUrl"> | null;
  isDesktopRenderer: boolean;
  primaryRunsInWsl: boolean;
}): FolderDropTarget {
  if (
    !input.localEnvironmentDisabled &&
    input.primaryEnvironmentId !== null &&
    input.environmentId === input.primaryEnvironmentId
  ) {
    return input.primaryRunsInWsl ? { wslBackendId: PRIMARY_LOCAL_ENVIRONMENT_ID } : "local";
  }
  if (!input.isDesktopRenderer || input.connection === null) return "remote";
  const backendId = desktopLocalBackendId(input.connection.target);
  if (backendId?.startsWith("wsl:")) return { wslBackendId: backendId };
  return isSavedLoopbackConnection(input.connection) ? "local" : "remote";
}

// A direct saved connection to loopback shares the desktop's filesystem; SSH forwards do not.
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
