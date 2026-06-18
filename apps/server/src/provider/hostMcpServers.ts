import type { DesktopBootstrapMcpServer } from "@t3tools/contracts";
import { mcpToolTimeoutMsFromSeconds } from "@t3tools/shared/mcp";

export interface HostMcpStdioServer {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly toolTimeoutSec?: number | undefined;
}

export function makeT3McpRelayCommand(socketPath: string): {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
} {
  const entrypoint = process.argv[1];
  if (!entrypoint || !isT3ServerEntrypoint(entrypoint)) {
    return { command: "t3", args: ["stdio-to-uds", socketPath], env: {} };
  }
  return {
    command: process.execPath,
    args: [entrypoint, "stdio-to-uds", socketPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function isT3ServerEntrypoint(entrypoint: string): boolean {
  return /(?:^|[/\\])(?:bin|cli)\.(?:[cm]?js|ts)$/u.test(entrypoint);
}

export function hostMcpServersToStdioServers(
  hostMcpServers: ReadonlyArray<DesktopBootstrapMcpServer>,
): ReadonlyArray<HostMcpStdioServer> {
  return hostMcpServers.map((server) => {
    const relay = makeT3McpRelayCommand(server.socketPath);
    return {
      name: server.name,
      command: relay.command,
      args: relay.args,
      env: relay.env,
      ...(server.toolTimeoutSec !== undefined ? { toolTimeoutSec: server.toolTimeoutSec } : {}),
    };
  });
}

export function hostMcpServersToOpenCodeConfigContent(
  hostMcpServers: ReadonlyArray<DesktopBootstrapMcpServer>,
): string {
  if (hostMcpServers.length === 0) {
    return "{}";
  }

  return JSON.stringify({
    mcp: Object.fromEntries(
      hostMcpServersToStdioServers(hostMcpServers).map((server) => {
        const timeout = mcpToolTimeoutMsFromSeconds(server.toolTimeoutSec);
        return [
          server.name,
          {
            type: "local",
            command: [server.command, ...server.args],
            ...(Object.keys(server.env).length > 0 ? { environment: server.env } : {}),
            enabled: true,
            ...(timeout !== undefined ? { timeout } : {}),
          },
        ];
      }),
    ),
  });
}
