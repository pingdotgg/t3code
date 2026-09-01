import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentAuthorizationError,
  type DesktopPreviewBridge,
  type PreviewUrlResolution,
} from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Schema from "effect/Schema";
import { useCallback } from "react";

import { previewEnvironment } from "~/state/preview";
import { readEnvironmentSupportsPreviewGateway } from "~/state/entities";
import { readPreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import { PreviewGatewayNavigationError } from "./previewAutomationErrors";

type GatewayCapablePreviewBridge = Partial<
  Pick<DesktopPreviewBridge, "configureGateway" | "clearGateway">
>;

const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

export function usePreparePreviewGatewayNavigation() {
  const issueGatewayTicket = useAtomCommand(previewEnvironment.issueGatewayTicket, {
    reportFailure: false,
  });

  return useCallback(
    async (resolution: PreviewUrlResolution): Promise<number | null> => {
      const environmentId = resolution.environmentId;
      const gatewayBridge = previewBridge as GatewayCapablePreviewBridge | null;
      if (resolution.resolutionKind !== "environment-gateway") {
        if (resolution.resolutionKind !== "direct" || !gatewayBridge?.clearGateway) return null;
        let target: URL;
        try {
          target = new URL(normalizePreviewUrl(resolution.resolvedUrl));
        } catch {
          return null;
        }
        if (!isLoopbackHost(target.hostname)) return null;
        try {
          await gatewayBridge.clearGateway(environmentId);
        } catch (cause) {
          throw new PreviewGatewayNavigationError({ reason: "configuration-failed", cause });
        }
        return null;
      }

      const target = new URL(resolution.resolvedUrl);
      const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
      if (target.protocol !== "http:") {
        throw new PreviewGatewayNavigationError({ reason: "unsupported-protocol", port });
      }
      if (!readEnvironmentSupportsPreviewGateway(environmentId)) {
        throw new PreviewGatewayNavigationError({ reason: "server-update-required", port });
      }
      const connection = readPreparedConnection(environmentId);
      if (!connection || !gatewayBridge?.configureGateway) {
        throw new PreviewGatewayNavigationError({ reason: "configuration-failed", port });
      }

      const result = await issueGatewayTicket({ environmentId, input: { port } });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        throw new PreviewGatewayNavigationError({
          reason: isEnvironmentAuthorizationError(cause)
            ? "authorization-insufficient"
            : "configuration-failed",
          port,
          cause,
        });
      }
      if (result.value.port !== port) {
        throw new PreviewGatewayNavigationError({ reason: "configuration-failed", port });
      }
      try {
        await gatewayBridge.configureGateway({
          environmentId,
          httpBaseUrl: connection.httpBaseUrl,
          ticket: result.value.ticket,
          port,
          expiresAtEpochMilliseconds: result.value.expiresAt.epochMilliseconds,
        });
      } catch (cause) {
        throw new PreviewGatewayNavigationError({ reason: "configuration-failed", port, cause });
      }
      return result.value.expiresAt.epochMilliseconds;
    },
    [issueGatewayTicket],
  );
}
