/**
 * Registry for user-configured MCP servers.
 *
 * Backs the MCP-servers settings panel: CRUD over `ServerSettings.mcpServers`
 * (persisted/redacted through `ServerSettingsService`, same as provider
 * instance environment variables) plus a `testConnection` that actually
 * speaks MCP to the server to list its tools. Session start merges every
 * `enabled` entry here into whichever agent CLI is driving a thread — see
 * `resolveSessionMcpServers.ts`.
 *
 * @module McpServerRegistry
 */
import {
  type McpServerConfig,
  McpServerId,
  McpServerRegistryError,
  type McpServerRemoveInput,
  type McpServerTestConnectionInput,
  type McpServerTestConnectionResult,
  type McpServerUpsertInput,
  type McpServerUpsertResult,
  type McpServersListResult,
  ServerSettingsError,
} from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";

import * as ServerSettings from "../serverSettings.ts";

export interface McpServerRegistryShape {
  readonly list: Effect.Effect<McpServersListResult, ServerSettingsError>;
  readonly upsert: (
    input: McpServerUpsertInput,
  ) => Effect.Effect<McpServerUpsertResult, ServerSettingsError>;
  readonly remove: (input: McpServerRemoveInput) => Effect.Effect<void, ServerSettingsError>;
  readonly testConnection: (
    input: McpServerTestConnectionInput,
  ) => Effect.Effect<McpServerTestConnectionResult, McpServerRegistryError | ServerSettingsError>;
}

export class McpServerRegistry extends Context.Service<McpServerRegistry, McpServerRegistryShape>()(
  "t3/mcp/McpServerRegistry",
) {}

function buildTransport(config: McpServerConfig): Transport {
  const transport = config.transport;
  if (transport.type === "stdio") {
    const env: Record<string, string> = {};
    for (const variable of transport.env ?? []) {
      env[variable.name] = variable.value;
    }
    return new StdioClientTransport({
      command: transport.command,
      args: [...transport.args],
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
      ...(transport.env ? { env } : {}),
    });
  }

  const url = new URL(transport.url);
  const headers: Record<string, string> = {};
  for (const header of transport.headers ?? []) {
    headers[header.name] = header.value;
  }
  const opts = transport.headers ? { requestInit: { headers } } : undefined;
  // The SDK's `sessionId` getters return `string | undefined`, which trips
  // `exactOptionalPropertyTypes` against `Transport.sessionId?: string` even
  // though both transports genuinely implement `Transport` at runtime.
  return transport.type === "sse"
    ? (new SSEClientTransport(url, opts) as unknown as Transport)
    : (new StreamableHTTPClientTransport(url, opts) as unknown as Transport);
}

const listToolNames = (
  config: McpServerConfig,
): Effect.Effect<ReadonlyArray<string>, McpServerRegistryError> =>
  Effect.tryPromise({
    try: async () => {
      const client = new Client({ name: "t3-code", version: "0.0.0" });
      const transport = buildTransport(config);
      try {
        await client.connect(transport);
        const { tools } = await client.listTools();
        return tools.map((tool) => tool.name);
      } finally {
        await client.close().catch(() => {});
      }
    },
    catch: (cause) =>
      new McpServerRegistryError({
        operation: "testConnection",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const list: McpServerRegistryShape["list"] = serverSettings.getSettings.pipe(
    Effect.map(ServerSettings.redactServerSettingsForClient),
    Effect.map((settings) => ({
      servers: Object.entries(settings.mcpServers).map(([id, config]) => ({
        id: McpServerId.make(id),
        config,
      })),
    })),
  );

  const upsert: McpServerRegistryShape["upsert"] = (input) =>
    Effect.gen(function* () {
      const current = yield* serverSettings.getSettings;
      const id = input.id ?? McpServerId.make(NodeCrypto.randomUUID());
      const mcpServers = { ...current.mcpServers, [id]: input.config };
      const next = yield* serverSettings.updateSettings({ mcpServers });
      const redacted = ServerSettings.redactServerSettingsForClient(next);
      return { id, config: redacted.mcpServers[id] ?? input.config };
    });

  const remove: McpServerRegistryShape["remove"] = (input) =>
    Effect.gen(function* () {
      const current = yield* serverSettings.getSettings;
      const mcpServers = { ...current.mcpServers };
      delete mcpServers[input.id];
      yield* serverSettings.updateSettings({ mcpServers });
    });

  const resolveTestConnectionConfig = (
    input: McpServerTestConnectionInput,
  ): Effect.Effect<McpServerConfig, McpServerRegistryError | ServerSettingsError> => {
    if (input.config) return Effect.succeed(input.config);
    if (!input.id) {
      return new McpServerRegistryError({
        operation: "testConnection",
        detail: "Either id or config must be provided.",
      });
    }
    const id = input.id;
    return serverSettings.getSettings.pipe(
      Effect.flatMap((settings) => {
        const existing = settings.mcpServers[id];
        return existing
          ? Effect.succeed(existing)
          : new McpServerRegistryError({
              operation: "testConnection",
              id,
              detail: `No MCP server registered with id ${id}.`,
            });
      }),
    );
  };

  const testConnection: McpServerRegistryShape["testConnection"] = (input) =>
    Effect.gen(function* () {
      const config = yield* resolveTestConnectionConfig(input);
      return yield* listToolNames(config).pipe(
        Effect.map((toolNames): McpServerTestConnectionResult => ({ status: "ok", toolNames })),
        Effect.catch(
          (error): Effect.Effect<McpServerTestConnectionResult> =>
            Effect.succeed({ status: "error", toolNames: [], detail: error.detail }),
        ),
      );
    });

  return McpServerRegistry.of({ list, upsert, remove, testConnection });
});

export const layer = Layer.effect(McpServerRegistry, make);
