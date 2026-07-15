import type { McpProviderSessionConfig } from "../mcp/McpProviderSession.ts";

export interface CopilotMcpBearerAuth {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
}

function normalizeCopilotMcpEndpoint(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      return undefined;
    }
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    // Query parameters may carry short-lived credentials supplied by the SDK;
    // they are not part of the configured MCP endpoint identity.
    url.search = "";
    return url.href;
  } catch {
    return undefined;
  }
}

export function resolveCopilotMcpBearerAuth(
  config: McpProviderSessionConfig | undefined,
  serverUrl: string,
): CopilotMcpBearerAuth | undefined {
  if (
    !config ||
    normalizeCopilotMcpEndpoint(config.endpoint) === undefined ||
    normalizeCopilotMcpEndpoint(config.endpoint) !== normalizeCopilotMcpEndpoint(serverUrl)
  ) {
    return undefined;
  }

  const match = /^Bearer[ \t]+(\S+)$/i.exec(config.authorizationHeader);
  const accessToken = match?.[1];
  return accessToken ? { accessToken, tokenType: "Bearer" } : undefined;
}
