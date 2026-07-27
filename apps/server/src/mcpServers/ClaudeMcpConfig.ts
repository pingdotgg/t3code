/**
 * ClaudeMcpConfig — read the MCP servers Claude Code loads for a session:
 * user scope and workspace `local` scope from `.claude.json`, plus approved
 * `.mcp.json` project servers.
 *
 * Entries are already in the shape the Agent SDK's `mcpServers` option accepts.
 * Reading the files directly (rather than shelling out to `claude mcp list`,
 * which health-checks every server over the network) keeps both the settings
 * inventory and session launch cheap.
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

/**
 * Where Claude Code found the server:
 *   - `user` — `mcpServers` in `.claude.json`, available everywhere
 *   - `local` — `projects.<cwd>.mcpServers` in `.claude.json`, private to the
 *     workspace
 *   - `project` — `.mcp.json` in the workspace, shared with the repo and only
 *     loaded once approved
 */
export type ClaudeMcpServerScope = "user" | "project" | "local";

export interface ClaudeMcpServerDefinition {
  readonly name: string;
  readonly scope: ClaudeMcpServerScope;
  /** Config file the entry was declared in. */
  readonly sourcePath: string;
  /** Verbatim config entry, already SDK-shaped. */
  readonly definition: Record<string, unknown>;
}

export interface ClaudeMcpServerRead {
  /**
   * False when a config file exists but could not be read or parsed, so the
   * list below may be missing servers the CLI would load. Callers that replace
   * the CLI's own resolution (`--strict-mcp-config`) must not act on an
   * incomplete list.
   */
  readonly complete: boolean;
  readonly definitions: ReadonlyArray<ClaudeMcpServerDefinition>;
}

function readServerMap(value: unknown): ReadonlyArray<readonly [string, Record<string, unknown>]> {
  if (typeof value !== "object" || value === null) return [];
  const entries: Array<readonly [string, Record<string, unknown>]> = [];
  for (const [rawName, rawEntry] of Object.entries(value as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name || typeof rawEntry !== "object" || rawEntry === null) continue;
    entries.push([name, rawEntry as Record<string, unknown>]);
  }
  return entries;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * A config file is either absent (no servers, and that is the truth), readable
 * (its parsed contents), or unusable — unreadable or malformed, meaning the
 * server list this file would contribute is unknown.
 */
type JsonFileRead =
  | { readonly kind: "absent" }
  | { readonly kind: "object"; readonly value: Record<string, unknown> }
  | { readonly kind: "unusable" };

const readJsonObject = Effect.fn("readClaudeJsonObject")(function* (
  filePath: string,
): Effect.fn.Return<JsonFileRead, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return { kind: "absent" };

  const contents = yield* fileSystem
    .readFileString(filePath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) return { kind: "unusable" };
  const decoded = decodeJsonOption(contents);
  if (decoded._tag === "None") return { kind: "unusable" };
  const parsed = decoded.value;
  return typeof parsed === "object" && parsed !== null
    ? { kind: "object", value: parsed as Record<string, unknown> }
    : { kind: "unusable" };
});

/**
 * Resolve the file Claude Code reads user-scoped MCP servers from, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~`. With a config dir set,
 * `.claude.json` lives inside it; otherwise it sits at `~/.claude.json`.
 */
export const resolveClaudeMcpConfigFilePath = Effect.fn("resolveClaudeMcpConfigFilePath")(
  function* (
    config: Pick<ClaudeSettings, "homePath">,
    environment: NodeJS.ProcessEnv,
    cwd?: string,
  ): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    const homePath = config.homePath.trim();
    if (homePath.length > 0) {
      return path.join(path.resolve(expandHomePath(homePath)), ".claude.json");
    }
    // No tilde expansion here, and relative values resolve against the
    // workspace cwd: the spawned CLI receives this env var verbatim (env vars
    // are never shell-expanded) and resolves it from its own cwd, so discovery
    // has to read the same directory the runtime would. Mirrors
    // `resolveClaudeConfigDirPath` in `ClaudeSkills`.
    const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
    if (environmentConfigDir.length > 0) {
      const configDir = cwd
        ? path.resolve(cwd, environmentConfigDir)
        : path.resolve(environmentConfigDir);
      return path.join(configDir, ".claude.json");
    }
    return path.join(NodeOS.homedir(), ".claude.json");
  },
);

/**
 * Enumerate every server the session would load: user scope, the workspace's
 * `local` scope, and approved `.mcp.json` project servers. Callers pair this
 * with `--strict-mcp-config`, so missing a scope here would silently drop
 * servers from the session — hence all three are read, not just user scope.
 *
 * Unapproved `.mcp.json` servers are skipped: the CLI would prompt for trust
 * before loading them, and passing them through explicitly would grant that
 * trust on the user's behalf. Approval state lives in the same
 * `projects.<cwd>` block the CLI writes it to.
 *
 * Best effort: a missing, unreadable, or malformed config contributes nothing
 * rather than failing the caller. On name collisions the narrower scope wins,
 * matching Claude Code's local > project > user resolution.
 */
export const readClaudeMcpServers = Effect.fn("readClaudeMcpServers")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<ClaudeMcpServerRead, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const configPath = yield* resolveClaudeMcpConfigFilePath(config, environment, cwd);
  const claudeRead = yield* readJsonObject(configPath);
  const claudeJson = claudeRead.kind === "object" ? claudeRead.value : undefined;
  let complete = claudeRead.kind !== "unusable";

  const byName = new Map<string, ClaudeMcpServerDefinition>();
  for (const [name, definition] of readServerMap(claudeJson?.mcpServers)) {
    byName.set(name, { name, scope: "user", sourcePath: configPath, definition });
  }

  if (cwd === undefined) {
    return { complete, definitions: [...byName.values()] };
  }

  const projects = claudeJson?.projects;
  const projectEntry =
    typeof projects === "object" && projects !== null
      ? ((projects as Record<string, unknown>)[path.resolve(cwd)] ??
        (projects as Record<string, unknown>)[cwd])
      : undefined;
  const projectConfig =
    typeof projectEntry === "object" && projectEntry !== null
      ? (projectEntry as Record<string, unknown>)
      : undefined;

  const mcpJsonPath = path.join(cwd, ".mcp.json");
  const mcpJsonRead = yield* readJsonObject(mcpJsonPath);
  const mcpJson = mcpJsonRead.kind === "object" ? mcpJsonRead.value : undefined;
  if (mcpJsonRead.kind === "unusable") complete = false;
  const approveAll = projectConfig?.enableAllProjectMcpServers === true;
  const approved = new Set(readStringArray(projectConfig?.enabledMcpjsonServers));
  const rejected = new Set(readStringArray(projectConfig?.disabledMcpjsonServers));
  for (const [name, definition] of readServerMap(mcpJson?.mcpServers)) {
    if (rejected.has(name) || (!approveAll && !approved.has(name))) continue;
    byName.set(name, { name, scope: "project", sourcePath: mcpJsonPath, definition });
  }

  for (const [name, definition] of readServerMap(projectConfig?.mcpServers)) {
    byName.set(name, { name, scope: "local", sourcePath: configPath, definition });
  }

  return { complete, definitions: [...byName.values()] };
});
