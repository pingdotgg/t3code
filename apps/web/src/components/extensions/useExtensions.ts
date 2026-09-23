import type { EnvironmentId, InstalledExtension } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import * as Option from "effect/Option";
import { useCallback } from "react";

import type { ExtensionSurfaceTarget } from "~/rightPanelStore";

import { useDeviceHubAccess } from "~/state/device";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { usePreparedConnection } from "~/state/session";

export function extensionHasUi(extension: InstalledExtension): boolean {
  return extension.viewContainers.length > 0;
}

export function extensionLaunchTargets(
  extension: InstalledExtension,
): { label: string; target: ExtensionSurfaceTarget }[] {
  if (!extension.enabled) return [];
  return extension.viewContainers.map((container) => ({
    label:
      extension.viewContainers.length === 1 || container.title === ""
        ? extension.displayName
        : `${extension.displayName}: ${container.title}`,
    target: { kind: "extension", extensionId: extension.id, viewContainerId: container.id },
  }));
}

export function useExtensions(environmentId: EnvironmentId | null) {
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.extensionsState({ environmentId, input: {} }),
  );
  const httpBaseUrl = Option.getOrNull(usePreparedConnection(environmentId))?.httpBaseUrl ?? null;
  const access = useDeviceHubAccess(environmentId);
  const resolveIconUrl = useCallback(
    (extension: InstalledExtension) => {
      if (!extension.iconUrl || !httpBaseUrl || !access) return null;
      const url = resolveAssetUrl(httpBaseUrl, extension.iconUrl);
      const ticket = access.query.wsTicket;
      return url && ticket ? `${url}?wsTicket=${encodeURIComponent(ticket)}` : url;
    },
    [access, httpBaseUrl],
  );
  return { state: query.data, error: query.error, resolveIconUrl };
}
