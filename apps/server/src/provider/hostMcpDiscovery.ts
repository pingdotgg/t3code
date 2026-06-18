// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as net from "node:net";
import type { DesktopBootstrapMcpServer, ProviderSessionStartInput } from "@t3tools/contracts";
import {
  cleanupHostMcpAdvertisements,
  mergeHostMcpServers,
  readHostMcpAdvertisements,
} from "@t3tools/shared/hostMcp";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import type { ServerConfigShape } from "../config.ts";

const DEFAULT_MCP_PROBE_TIMEOUT_MS = 750;
const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface ResolveHostMcpServersInput {
  readonly t3Home: string;
  readonly workspaceRoot?: string | undefined;
  readonly bootstrapServers: readonly DesktopBootstrapMcpServer[];
  readonly probe?: (socketPath: string) => Promise<boolean>;
  readonly socketPathExists?: (socketPath: string) => boolean;
}

export async function resolveHostMcpServersForWorkspace(
  input: ResolveHostMcpServersInput,
): Promise<readonly DesktopBootstrapMcpServer[]> {
  if (!input.workspaceRoot) {
    return input.bootstrapServers;
  }

  let readResult: ReturnType<typeof readHostMcpAdvertisements>;
  try {
    cleanupHostMcpAdvertisements({ t3Home: input.t3Home });
    readResult = readHostMcpAdvertisements({
      t3Home: input.t3Home,
      workspaceRoot: input.workspaceRoot,
    });
  } catch {
    return input.bootstrapServers;
  }
  const socketPathExists = input.socketPathExists ?? defaultSocketPathExists;
  const probe = input.probe ?? probeMcpSocket;
  const bootstrapNames = new Set(input.bootstrapServers.map((server) => server.name));

  for (const advertisement of readResult.advertisements) {
    const server = advertisement.mcpServer;
    if (bootstrapNames.has(server.name)) {
      continue;
    }
    if (!socketPathExists(server.socketPath)) {
      continue;
    }
    if (!(await probe(server.socketPath))) {
      continue;
    }
    return mergeHostMcpServers(input.bootstrapServers, [server]);
  }

  return input.bootstrapServers;
}

export function resolveHostMcpServersForProviderStart(input: {
  readonly serverConfig: Pick<ServerConfigShape, "baseDir" | "hostMcpServers">;
  readonly sessionInput: Pick<ProviderSessionStartInput, "cwd" | "projectWorkspaceRoot">;
}): Promise<readonly DesktopBootstrapMcpServer[]> {
  // Provider startup treats host MCP discovery as best-effort. Bad or stale host
  // advertisements must not block the provider process from starting with the
  // configured bootstrap servers.
  return resolveHostMcpServersForWorkspace({
    t3Home: input.serverConfig.baseDir,
    workspaceRoot: input.sessionInput.projectWorkspaceRoot ?? input.sessionInput.cwd,
    bootstrapServers: input.serverConfig.hostMcpServers,
  }).catch(() => input.serverConfig.hostMcpServers);
}

export function defaultSocketPathExists(socketPath: string): boolean {
  if (Effect.runSync(HostProcessPlatform) === "win32" && socketPath.startsWith("\\\\.\\pipe\\")) {
    // Windows named pipes are not reliably visible through fs.existsSync. Let the
    // subsequent protocol probe perform the authoritative availability check.
    return true;
  }
  return fs.existsSync(socketPath);
}

export function probeMcpSocket(
  socketPath: string,
  timeoutMs = DEFAULT_MCP_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();

    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (!socket.destroyed) {
        socket.destroy();
      }
      resolve(result);
    };

    socket.once("connect", () => {
      const payload = {
        jsonrpc: "2.0",
        id: "t3-host-mcp-probe",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: {
            name: "t3-code-host-mcp-discovery",
            version: "0.0.0",
          },
        },
      };
      socket.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex));
        settle(
          response?.jsonrpc === "2.0" &&
            response?.id === "t3-host-mcp-probe" &&
            typeof response?.result?.serverInfo?.name === "string",
        );
      } catch {
        settle(false);
      }
    });
    socket.once("error", () => settle(false));
    socket.once("close", () => settle(false));
  });
}
