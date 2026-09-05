import type { BrowserNavigationTarget, EnvironmentId } from "@t3tools/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";

import { previewEnvironmentPost } from "./browserEnvironmentHttp";
import { readPreparedConnection } from "~/state/session";
import { previewBridge } from "~/components/preview/previewBridge";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  resolveBrowserNavigationTarget,
  rememberForwardedOrigin,
  restoreForwardedBrowserUrl,
} from "./browserTargetResolver";

/** Keep app traffic on a separate loopback origin while reusing the environment's tunnel. */
export async function resolveForwardedBrowserTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): Promise<string> {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  const environmentUrl = new URL(connection.httpBaseUrl);
  const requested =
    target.kind === "url"
      ? new URL(restoreForwardedBrowserUrl(environmentId, normalizePreviewUrl(target.url)))
      : new URL(
          `${target.protocol ?? "http"}://localhost:${target.port}${target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`}`,
        );
  const environmentPort =
    target.kind === "environment-port" ||
    isLoopbackHost(requested.hostname) ||
    isLocalLoopbackHost(requested.hostname) ||
    (requested.hostname === environmentUrl.hostname && requested.port !== environmentUrl.port);
  if (!environmentPort || isPrivateNetworkHost(environmentUrl.hostname)) {
    return resolveBrowserNavigationTarget(environmentId, target).resolvedUrl;
  }
  if (!previewBridge?.ensurePortForward) {
    throw new Error("Update the desktop app to preview remote ports through T3 Connect.");
  }
  const port = Number(requested.port || (requested.protocol === "https:" ? 443 : 80));
  const response = await previewEnvironmentPost(environmentId, "/api/auth/websocket-ticket");
  if (!response.ok) throw new Error(`Preview authorization failed (${response.status}).`);
  const ticket: unknown = await response.json();
  if (
    typeof ticket !== "object" ||
    ticket === null ||
    !("ticket" in ticket) ||
    typeof ticket.ticket !== "string"
  )
    throw new Error("Invalid preview authorization response.");
  const socketUrl = new URL("/api/preview/forward", response.url || connection.httpBaseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  socketUrl.searchParams.set("port", String(port));
  socketUrl.searchParams.set("wsTicket", ticket.ticket);
  const localPort = await previewBridge.ensurePortForward(
    `${environmentId}:${environmentUrl.origin}:${requested.origin}:${port}`,
    socketUrl.toString(),
  );
  const requestedOrigin = requested.origin;
  if (requested.hostname !== "localhost") requested.hostname = "127.0.0.1";
  requested.port = String(localPort);
  rememberForwardedOrigin(environmentId, requested.origin, requestedOrigin);
  return requested.toString();
}
