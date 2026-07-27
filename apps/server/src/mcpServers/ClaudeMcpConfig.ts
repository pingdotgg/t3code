/**
 * ClaudeMcpConfig — read the user-scoped MCP servers Claude Code loads.
 *
 * Claude Code keeps them in `.claude.json`, in the same shape the Agent SDK's
 * `mcpServers` option accepts. Reading the file directly (rather than shelling
 * out to `claude mcp list`, which health-checks every server over the network)
 * keeps both the settings inventory and session launch cheap.
 *
 * @module mcpServers/ClaudeMcpConfig
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";

const decodeJsonOption = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

export interface ClaudeMcpServerDefinition {
  readonly name: string;
  /** Verbatim `.claude.json` entry, already SDK-shaped. */
  readonly definition: Record<string, unknown>;
}

/**
 * Resolve the file Claude Code reads user-scoped MCP servers from. With
 * `CLAUDE_CONFIG_DIR` set (T3's `homePath`), `.claude.json` lives inside that
 * directory; otherwise it sits at `~/.claude.json`.
 */
export const resolveClaudeMcpConfigFilePath = Effect.fn("resolveClaudeMcpConfigFilePath")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const homePath = config.homePath.trim();
    if (homePath.length > 0) {
      return path.join(path.resolve(expandHomePath(homePath)), ".claude.json");
    }
    const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
    if (environmentConfigDir.length > 0) {
      return path.join(path.resolve(environmentConfigDir), ".claude.json");
    }
    return path.join(NodeOS.homedir(), ".claude.json");
  },
);

/**
 * Enumerate the declared servers. Best effort: a missing, unreadable, or
 * malformed config yields an empty list rather than failing the caller.
 */
export const readClaudeMcpServers = Effect.fn("readClaudeMcpServers")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ReadonlyArray<ClaudeMcpServerDefinition>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const configPath = yield* resolveClaudeMcpConfigFilePath(config, environment);
  const contents = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return [];

  const decoded = decodeJsonOption(contents);
  if (decoded._tag === "None") return [];
  const parsed = decoded.value;
  const servers =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { readonly mcpServers?: unknown }).mcpServers
      : undefined;
  if (typeof servers !== "object" || servers === null) return [];

  const definitions: Array<ClaudeMcpServerDefinition> = [];
  for (const [rawName, rawEntry] of Object.entries(servers as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name || typeof rawEntry !== "object" || rawEntry === null) continue;
    definitions.push({ name, definition: rawEntry as Record<string, unknown> });
  }
  return definitions;
});
