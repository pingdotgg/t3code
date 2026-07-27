/**
 * McpServerInventory — cross-harness discovery of the MCP servers each
 * provider instance loads, plus the T3-owned disable list applied on top.
 *
 * Discovery is read-only and best effort: unreadable config and CLI failures
 * yield an empty list for that instance rather than failing the request, the
 * same contract `discoverClaudeSkills` follows for skills.
 *
 * Sources, per harness:
 *   - Claude reads `.claude.json` directly. The CLI's own `claude mcp list`
 *     health-checks every server over the network, which is far too slow for
 *     a settings page.
 *   - Codex shells out to `codex mcp list --json`, which already reports the
 *     `enabled` flag Codex honours natively. That avoids parsing `config.toml`
 *     (no TOML parser is vendored) and stays correct across config layouts.
 *
 * @module mcpServers/McpServerInventory
 */
import type {
  McpServerInventory,
  McpServerInventoryEntry,
  McpServerTransport,
  ProviderInstanceConfig,
} from "@t3tools/contracts";
import { ClaudeSettings, CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { readClaudeMcpServers, resolveClaudeMcpConfigFilePath } from "./ClaudeMcpConfig.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

/** Codex is spawned only to read config; a slow CLI must not hang the page. */
const CODEX_LIST_TIMEOUT_MS = 10_000;

export type McpInventoryEnv = FileSystem.FileSystem | Path.Path;

function harnessDisplayName(instance: ProviderInstanceConfig, fallback: string): string {
  return instance.displayName?.trim() || fallback;
}

function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Render a stdio server as its command line for display. Environment values
 * are deliberately dropped: MCP `env` blocks routinely hold API keys, and this
 * inventory is served to remote clients.
 */
function stdioDetail(command: string, args: unknown): string {
  const parts = Array.isArray(args)
    ? args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return [command, ...parts].join(" ");
}

function claudeTransport(entry: Record<string, unknown>): McpServerTransport {
  const declared = trimmedOrUndefined(entry.type);
  if (declared === "http" || declared === "sse") return declared;
  if (declared === "stdio") return "stdio";
  // Older entries omit `type`; a `url` means a remote server.
  return trimmedOrUndefined(entry.url) ? "http" : "stdio";
}

const discoverClaudeMcpServers = Effect.fn("McpServerInventory.discoverClaudeMcpServers")(
  function* (
    instanceId: string,
    instance: ProviderInstanceConfig,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<ReadonlyArray<McpServerInventoryEntry>, never, McpInventoryEnv> {
    const decoded = decodeClaudeSettings(instance.config ?? {});
    if (decoded._tag === "None") return [];
    const settings = decoded.value;

    const configPath = yield* resolveClaudeMcpConfigFilePath(settings, environment);
    const definitions = yield* readClaudeMcpServers(settings, environment);

    const disabled = new Set(settings.disabledMcpServers);
    const entries: McpServerInventoryEntry[] = [];
    for (const { name, definition: entry } of definitions) {
      const transport = claudeTransport(entry);
      const command = trimmedOrUndefined(entry.command);
      const url = trimmedOrUndefined(entry.url);
      const detail = transport === "stdio" && command ? stdioDetail(command, entry.args) : url;

      entries.push({
        providerInstanceId: ProviderInstanceId.make(instanceId),
        harness: instance.driver,
        harnessDisplayName: harnessDisplayName(instance, "Claude"),
        name,
        transport,
        ...(detail ? { detail } : {}),
        configPath,
        enabled: !disabled.has(name),
        toggleable: true,
      });
    }
    return entries;
  },
);

function codexTransport(transport: unknown): {
  readonly transport: McpServerTransport;
  readonly detail: string | undefined;
} {
  if (typeof transport !== "object" || transport === null) {
    return { transport: "stdio", detail: undefined };
  }
  const record = transport as Record<string, unknown>;
  const type = trimmedOrUndefined(record.type);
  const command = trimmedOrUndefined(record.command);
  if (type === "stdio" || command) {
    return {
      transport: "stdio",
      detail: command ? stdioDetail(command, record.args) : undefined,
    };
  }
  return {
    transport: type === "sse" ? "sse" : "http",
    detail: trimmedOrUndefined(record.url),
  };
}

const discoverCodexMcpServers = Effect.fn("McpServerInventory.discoverCodexMcpServers")(function* (
  instanceId: string,
  instance: ProviderInstanceConfig,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ReadonlyArray<McpServerInventoryEntry>,
  never,
  McpInventoryEnv | ChildProcessSpawner.ChildProcessSpawner
> {
  const decoded = decodeCodexSettings(instance.config ?? {});
  if (decoded._tag === "None") return [];
  const settings = decoded.value;

  const layout = yield* resolveCodexHomeLayout(settings);
  const codexEnvironment = {
    ...environment,
    ...(layout.effectiveHomePath ? { CODEX_HOME: layout.effectiveHomePath } : {}),
  };
  const spawnCommand = yield* resolveSpawnCommand(settings.binaryPath, ["mcp", "list", "--json"], {
    env: codexEnvironment,
    extendEnv: true,
  });
  const result = yield* spawnAndCollect(
    settings.binaryPath,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: codexEnvironment,
      extendEnv: true,
      shell: spawnCommand.shell,
    }),
  ).pipe(Effect.timeoutOption(CODEX_LIST_TIMEOUT_MS), Effect.result);

  if (result._tag === "Failure" || result.success._tag === "None") return [];
  const output = result.success.value;
  if (output.code !== 0) return [];

  const decodedOutput = decodeJsonOption(output.stdout);
  if (decodedOutput._tag === "None") return [];
  const parsed = decodedOutput.value;
  if (!Array.isArray(parsed)) return [];

  const disabled = new Set(settings.disabledMcpServers);
  const entries: McpServerInventoryEntry[] = [];
  for (const rawEntry of parsed) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue;
    const entry = rawEntry as Record<string, unknown>;
    const name = trimmedOrUndefined(entry.name);
    if (!name) continue;
    const { transport, detail } = codexTransport(entry.transport);
    const authStatus = trimmedOrUndefined(entry.auth_status);

    entries.push({
      providerInstanceId: ProviderInstanceId.make(instanceId),
      harness: instance.driver,
      harnessDisplayName: harnessDisplayName(instance, "Codex"),
      name,
      transport,
      ...(detail ? { detail } : {}),
      configPath: layout.sharedHomePath,
      ...(authStatus && authStatus !== "unsupported" ? { status: authStatus } : {}),
      // Codex reports its own `enabled` flag; a server disabled in either
      // Codex config or T3 settings reads as off.
      enabled: entry.enabled !== false && !disabled.has(name),
      toggleable: true,
    });
  }
  return entries;
});

const discoverInstanceMcpServers = Effect.fn("McpServerInventory.discoverInstanceMcpServers")(
  function* (
    instanceId: string,
    instance: ProviderInstanceConfig,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<
    ReadonlyArray<McpServerInventoryEntry>,
    never,
    McpInventoryEnv | ChildProcessSpawner.ChildProcessSpawner
  > {
    if (instance.driver === "claudeAgent") {
      return yield* discoverClaudeMcpServers(instanceId, instance, environment);
    }
    if (instance.driver === "codex") {
      return yield* discoverCodexMcpServers(instanceId, instance, environment);
    }
    // ponytail: Cursor, Grok, and OpenCode run over ACP, which can add MCP
    // servers to a session but never suppress the ones the agent loads from
    // its own config. Listing without a working switch would be a lie, so
    // they stay out until a per-CLI lever exists.
    return [];
  },
);

export const discoverGlobalMcpInventory = Effect.fn(
  "McpServerInventory.discoverGlobalMcpInventory",
)(function* (
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<
  McpServerInventory,
  never,
  McpInventoryEnv | ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
> {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
  const providerInstances = deriveProviderInstanceConfigMap(settings);
  const resolvedEnvironment = environment ?? process.env;

  const discovered = yield* Effect.forEach(
    Object.entries(providerInstances),
    ([instanceId, instance]) =>
      discoverInstanceMcpServers(instanceId, instance, resolvedEnvironment),
    { concurrency: "unbounded" },
  );

  return {
    scannedAt: DateTime.formatIso(yield* DateTime.now),
    servers: discovered
      .flat()
      .sort(
        (left, right) =>
          left.harnessDisplayName.localeCompare(right.harnessDisplayName) ||
          left.name.localeCompare(right.name),
      ),
  };
});
