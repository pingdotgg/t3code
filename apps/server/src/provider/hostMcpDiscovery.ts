// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import type { DesktopBootstrapMcpServer, ProviderSessionStartInput } from "@t3tools/contracts";
import {
  cleanupHostMcpAdvertisements,
  mergeHostMcpServers,
  readHostMcpAdvertisements,
} from "@t3tools/shared/hostMcp";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ServerConfig } from "../config.ts";

const DEFAULT_MCP_PROBE_TIMEOUT_MS = 750;
const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface ResolveHostMcpServersInput {
  readonly t3Home: string;
  readonly workspaceRoot?: string | undefined;
  readonly bootstrapServers: readonly DesktopBootstrapMcpServer[];
  readonly probe?: (socketPath: string) => Promise<boolean>;
  readonly socketPathExists?: (socketPath: string) => boolean;
}

export class HostMcpDiscovery extends Context.Service<
  HostMcpDiscovery,
  {
    readonly resolveForWorkspace: (
      input: ResolveHostMcpServersInput,
    ) => Effect.Effect<readonly DesktopBootstrapMcpServer[]>;
    readonly resolveForProviderStart: (input: {
      readonly serverConfig: Pick<ServerConfig["Service"], "baseDir" | "hostMcpServers">;
      readonly sessionInput: Pick<ProviderSessionStartInput, "cwd" | "projectWorkspaceRoot">;
    }) => Effect.Effect<readonly DesktopBootstrapMcpServer[]>;
  }
>()("t3/provider/hostMcpDiscovery") {}

export const resolveHostMcpServersForWorkspaceEffect = Effect.fn(
  "HostMcpDiscovery.resolveHostMcpServersForWorkspace",
)(function* (input: ResolveHostMcpServersInput) {
  if (!input.workspaceRoot) {
    return input.bootstrapServers;
  }

  const readResult = yield* Effect.sync(() => {
    try {
      cleanupHostMcpAdvertisements({ t3Home: input.t3Home });
      return readHostMcpAdvertisements({
        t3Home: input.t3Home,
        workspaceRoot: input.workspaceRoot,
      });
    } catch {
      return null;
    }
  });
  if (readResult === null) {
    return input.bootstrapServers;
  }
  const socketPathExists = input.socketPathExists
    ? (socketPath: string) =>
        Effect.sync(() => input.socketPathExists?.(socketPath) === true).pipe(
          Effect.orElseSucceed(() => false),
        )
    : defaultSocketPathExistsEffect;
  const probe = input.probe
    ? (socketPath: string) =>
        Effect.promise(() => input.probe?.(socketPath) ?? Promise.resolve(false)).pipe(
          Effect.orElseSucceed(() => false),
        )
    : probeMcpSocketEffect;
  const bootstrapNames = new Set(input.bootstrapServers.map((server) => server.name));

  for (const advertisement of readResult.advertisements) {
    const server = advertisement.mcpServer;
    if (bootstrapNames.has(server.name)) {
      continue;
    }
    if (!(yield* socketPathExists(server.socketPath))) {
      continue;
    }
    if (!(yield* probe(server.socketPath))) {
      continue;
    }
    return mergeHostMcpServers(input.bootstrapServers, [server]);
  }

  return input.bootstrapServers;
});

export function resolveHostMcpServersForWorkspace(
  input: ResolveHostMcpServersInput,
): Promise<readonly DesktopBootstrapMcpServer[]> {
  return Effect.runPromise(resolveHostMcpServersForWorkspaceEffect(input));
}

export const resolveHostMcpServersForProviderStartEffect = Effect.fn(
  "HostMcpDiscovery.resolveHostMcpServersForProviderStart",
)(function* (input: {
  readonly serverConfig: Pick<ServerConfig["Service"], "baseDir" | "hostMcpServers">;
  readonly sessionInput: Pick<ProviderSessionStartInput, "cwd" | "projectWorkspaceRoot">;
}) {
  // Provider startup treats host MCP discovery as best-effort. Bad or stale host
  // advertisements must not block the provider process from starting with the
  // configured bootstrap servers.
  return yield* resolveHostMcpServersForWorkspaceEffect({
    t3Home: input.serverConfig.baseDir,
    workspaceRoot: input.sessionInput.projectWorkspaceRoot ?? input.sessionInput.cwd,
    bootstrapServers: input.serverConfig.hostMcpServers,
  }).pipe(Effect.catchCause(() => Effect.succeed(input.serverConfig.hostMcpServers)));
});

export function resolveHostMcpServersForProviderStart(input: {
  readonly serverConfig: Pick<ServerConfig["Service"], "baseDir" | "hostMcpServers">;
  readonly sessionInput: Pick<ProviderSessionStartInput, "cwd" | "projectWorkspaceRoot">;
}): Promise<readonly DesktopBootstrapMcpServer[]> {
  return Effect.runPromise(resolveHostMcpServersForProviderStartEffect(input));
}

export const make = HostMcpDiscovery.of({
  resolveForWorkspace: resolveHostMcpServersForWorkspaceEffect,
  resolveForProviderStart: resolveHostMcpServersForProviderStartEffect,
});

export const layer = Layer.succeed(HostMcpDiscovery, make);

export const defaultSocketPathExistsEffect = Effect.fn("HostMcpDiscovery.defaultSocketPathExists")(
  function* (socketPath: string) {
    const platform = yield* HostProcessPlatform;
    if (platform === "win32" && socketPath.startsWith("\\\\.\\pipe\\")) {
      // Windows named pipes are not reliably visible through NodeFS.existsSync. Let the
      // subsequent protocol probe perform the authoritative availability check.
      return true;
    }
    return yield* Effect.sync(() => NodeFS.existsSync(socketPath));
  },
);

export function defaultSocketPathExists(socketPath: string): boolean {
  return Effect.runSync(defaultSocketPathExistsEffect(socketPath));
}

export const probeMcpSocketEffect = (
  socketPath: string,
  timeoutMs = DEFAULT_MCP_PROBE_TIMEOUT_MS,
) => Effect.promise(() => probeMcpSocket(socketPath, timeoutMs));

export function probeMcpSocket(
  socketPath: string,
  timeoutMs = DEFAULT_MCP_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = NodeNet.createConnection(socketPath);
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
