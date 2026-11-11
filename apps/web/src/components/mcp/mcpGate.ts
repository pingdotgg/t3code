import type { ServerConfig } from "@t3tools/contracts";

/** What stands between the user and the wizard's steps. Only `open` lets them go on. */
export type McpGate =
  | { readonly kind: "checking" }
  | { readonly kind: "disconnected" }
  | { readonly kind: "update" }
  | { readonly kind: "no-tailnet-https" }
  | { readonly kind: "open"; readonly mcpUrl: string };

/** The `/mcp` address on the environment's tailnet HTTPS name, or null when it has none. */
function tailnetMcpUrl(config: Pick<ServerConfig, "directEndpoints">): string | null {
  const endpoint = config.directEndpoints?.find(
    (candidate) => candidate.kind === "tailnet" && candidate.httpBaseUrl.startsWith("https://"),
  );
  return endpoint === undefined ? null : new URL("/mcp", endpoint.httpBaseUrl).toString();
}

export function resolveMcpGate(input: {
  readonly connected: boolean;
  /** Undefined until the environment's config loads. */
  readonly serverConfig: Pick<ServerConfig, "environment" | "directEndpoints"> | undefined;
}): McpGate {
  if (!input.connected) return { kind: "disconnected" };
  const { serverConfig } = input;
  if (serverConfig === undefined) return { kind: "checking" };
  if (serverConfig.environment.capabilities.mcpApprovalCodes !== true) return { kind: "update" };
  const mcpUrl = tailnetMcpUrl(serverConfig);
  return mcpUrl === null ? { kind: "no-tailnet-https" } : { kind: "open", mcpUrl };
}
