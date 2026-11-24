import {
  connectionRouteId,
  connectionRouteKind,
  connectionRoutes,
  type ConnectionCatalogEntry,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";

type CritForwarding =
  | { readonly kind: "local" }
  | { readonly kind: "ssh" }
  | { readonly kind: "tailscale" };

/** Forward through the connected route, which can change after reconnecting. */
export function resolveCritForwarding(
  entry: ConnectionCatalogEntry | null,
  connection: PreparedConnection | null,
): CritForwarding {
  if (entry === null || connection === null) {
    throw new Error("The environment is not ready to open Crit. Wait for it to reconnect.");
  }
  if (connection.target._tag === "SshConnectionTarget") return { kind: "ssh" };
  const route = connectionRoutes(entry).find(
    (candidate) => connectionRouteId(candidate.target) === connectionRouteId(connection.target),
  );
  const hostname = new URL(connection.httpBaseUrl).hostname;
  if ((route && connectionRouteKind(route) === "tailnet") || isTailnetHost(hostname)) {
    return { kind: "tailscale" };
  }
  if (isLocalLoopbackHost(hostname)) return { kind: "local" };
  throw new Error("Remote Crit reviews require a Tailscale or SSH connection.");
}
