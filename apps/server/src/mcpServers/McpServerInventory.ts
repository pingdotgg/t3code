/**
 * McpServerInventory — cross-harness discovery of the MCP servers each provider
 * instance loads.
 *
 * This is about the *user's own* MCP servers, the ones the underlying CLIs load
 * from their own config. Not to be confused with `../mcp/`, which is T3 Code
 * acting as an MCP server and exposing the `preview_*` toolkit to agents.
 *
 * Discovery is read-only and best effort: an unreadable config yields an empty
 * list for that instance rather than failing the request, the same contract
 * `discoverClaudeSkills` follows for skills. No harness config file is ever
 * written.
 *
 * Claude is read by parsing `.claude.json` directly: the CLI's own
 * `claude mcp list` health-checks every server over the network, which is far
 * too slow for a settings page.
 *
 * Only Claude is covered for now. Codex needs a `codex mcp list --json`
 * subprocess, and Cursor, Grok, and OpenCode run over ACP, which never reports
 * the servers the agent loads from its own config.
 *
 * @module mcpServers/McpServerInventory
 */
import type {
  McpServerInventory,
  McpServerInventoryEntry,
  McpServerTransport,
  McpServerUnreadableConfig,
  ProviderInstanceConfig,
  ServerSettings,
} from "@t3tools/contracts";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { readClaudeMcpServers } from "./ClaudeMcpConfig.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/** One instance per configured harness is the norm; keep the fan-out bounded. */
const DISCOVERY_CONCURRENCY = 4;

export type McpInventoryEnv = FileSystem.FileSystem | Path.Path;

interface InstanceDiscovery {
  readonly entries: ReadonlyArray<McpServerInventoryEntry>;
  readonly unreadable: ReadonlyArray<McpServerUnreadableConfig>;
}

const EMPTY_DISCOVERY: InstanceDiscovery = { entries: [], unreadable: [] };

function harnessDisplayName(instance: ProviderInstanceConfig, fallback: string): string {
  return instance.displayName?.trim() || fallback;
}

function trimmedOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const REDACTED = "…";
/**
 * Shape of an argument safe to echo verbatim: a flag, a package specifier
 * (including a scoped `@scope/name`, with or without a version), a subcommand,
 * or a filesystem path (POSIX, home-relative, or Windows drive). Anything with
 * other punctuation — a quoted header, a connection string, a token containing
 * `+`, `$`, or `:` — fails and is redacted.
 */
const SAFE_ARGUMENT_PATTERN =
  /^(?:-{0,2}[A-Za-z0-9]|@[A-Za-z0-9][A-Za-z0-9._-]*[\\/]|[.~]?[\\/]|[A-Za-z]:[\\/])[A-Za-z0-9._/\\@_-]*$/;
/** Flag names whose value is a credential. Over-matching here is harmless. */
const SECRET_HINT_PATTERN =
  /(token|key|secret|password|passwd|credential|auth|bearer|pat|dsn|cookie|session|header)/i;

/** A word that looks structural and does not name a credential. */
function isSafeToShow(value: string): boolean {
  return SAFE_ARGUMENT_PATTERN.test(value) && !SECRET_HINT_PATTERN.test(value);
}

/**
 * Render a stdio server as its command line for display. Environment values are
 * dropped entirely, and an argument is shown only if it both looks structural
 * and is not the value of a credential-carrying flag.
 *
 * Two signals are needed because neither is sufficient. Shape alone catches
 * `postgres://u:p@host/db` and `Authorization: Bearer …` but would happily
 * print a bare `hunter2`; a flag-name blocklist alone catches `--token secret`
 * but misses everything positional. Together they cover every form seen in real
 * MCP configs except one: a bare positional secret that also looks like a word.
 * That residue is accepted — this is a display string, and the alternative is
 * showing nothing useful at all.
 */
export function stdioDetail(command: string, args: unknown): string {
  const parts = Array.isArray(args)
    ? args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const rendered: Array<string> = [];
  let redactNext = false;
  for (const part of parts) {
    if (redactNext) {
      // Redact whatever it looks like: a credential can start with `-`, so
      // "it parses as a flag" is not evidence that it is one. It may still be
      // one though — in `--token --api-key hunter2` either reading of the
      // middle argument leaves `hunter2` a secret — so re-arm rather than
      // letting the next value through.
      redactNext = part.startsWith("-") && SECRET_HINT_PATTERN.test(part);
      rendered.push(REDACTED);
      continue;
    }
    // `--flag=value` keeps the flag so the shape stays readable; the value goes
    // whenever the flag hints at a credential or the value itself looks unsafe.
    const inlineSeparator = part.indexOf("=");
    if (inlineSeparator > 0) {
      const flag = part.slice(0, inlineSeparator);
      const value = part.slice(inlineSeparator + 1);
      if (!SAFE_ARGUMENT_PATTERN.test(flag)) {
        rendered.push(REDACTED);
        continue;
      }
      const unsafeValue = SECRET_HINT_PATTERN.test(flag) || !SAFE_ARGUMENT_PATTERN.test(value);
      rendered.push(unsafeValue ? `${flag}=${REDACTED}` : part);
      continue;
    }
    if (!SAFE_ARGUMENT_PATTERN.test(part)) {
      rendered.push(REDACTED);
      continue;
    }
    if (part.startsWith("-") && SECRET_HINT_PATTERN.test(part)) redactNext = true;
    rendered.push(part);
  }
  // The command is config data too — it can be a credential-bearing URL, or the
  // secret itself — so it gets the same treatment as a positional argument.
  return [isSafeToShow(command) ? command : REDACTED, ...rendered].join(" ");
}

/**
 * Render a remote server's URL without its credentials. Only the origin is
 * shown: the query, the fragment, the userinfo, *and* the path all routinely
 * carry API keys (`?api_key=…`, `https://token@host/mcp`, `/mcp/<token>`), and
 * the host on its own already identifies the server.
 */
export function remoteDetail(rawUrl: string | undefined): string | undefined {
  if (rawUrl === undefined) return undefined;
  try {
    const url = new URL(rawUrl);
    const credentialed = url.username.length > 0 || url.password.length > 0;
    return `${url.protocol}//${credentialed ? `${REDACTED}@` : ""}${url.host}`;
  } catch {
    // Not a parseable URL, so nothing can be said about which part is a secret.
    return REDACTED;
  }
}

/**
 * Server names come from a config file we do not control. Control characters —
 * notably the RTL override U+202E — would reorder how a row reads on screen,
 * and an unbounded name is a wire and layout hazard. React escapes markup, so
 * this is about what a name can *look* like, not injection.
 */
const MAX_DISPLAY_NAME_LENGTH = 120;

function sanitizeDisplayName(name: string): string {
  const stripped = name.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  // A name made only of control characters has nothing left to show; falling
  // back to the raw name would put the override right back on screen.
  const safe = stripped.length > 0 ? stripped : "?";
  return safe.length > MAX_DISPLAY_NAME_LENGTH
    ? `${safe.slice(0, MAX_DISPLAY_NAME_LENGTH)}…`
    : safe;
}

function claudeTransport(entry: Record<string, unknown>): McpServerTransport {
  const declared = trimmedOrUndefined(entry.type);
  if (declared === "http" || declared === "sse") return declared;
  if (declared === "stdio") return "stdio";
  // Older entries omit `type`; a `url` means a remote server.
  return trimmedOrUndefined(entry.url) ? "http" : "stdio";
}

export const discoverClaudeMcpServerEntries = Effect.fn(
  "McpServerInventory.discoverClaudeMcpServerEntries",
)(function* (
  instanceId: string,
  instance: ProviderInstanceConfig,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
): Effect.fn.Return<InstanceDiscovery, never, McpInventoryEnv> {
  const decoded = decodeClaudeSettings(instance.config ?? {});
  if (decoded._tag === "None") return EMPTY_DISCOVERY;
  const settings = decoded.value;

  const displayName = harnessDisplayName(instance, "Claude");
  const { complete, definitions, unreadablePaths } = yield* readClaudeMcpServers(
    settings,
    environment,
    cwd,
  );

  const entries: McpServerInventoryEntry[] = [];
  for (const { name, scope, sourcePath, definition: entry } of definitions) {
    const transport = claudeTransport(entry);
    const command = trimmedOrUndefined(entry.command);
    const detail =
      transport === "stdio" && command
        ? stdioDetail(command, entry.args)
        : remoteDetail(trimmedOrUndefined(entry.url));

    entries.push({
      providerInstanceId: ProviderInstanceId.make(instanceId),
      harness: instance.driver,
      harnessDisplayName: displayName,
      name: sanitizeDisplayName(name),
      transport,
      ...(detail ? { detail } : {}),
      configPath: sourcePath,
      scope,
      // Claude Code has no per-server enable flag: everything it resolves is
      // loaded.
      enabled: true,
    });
  }

  // Every row here came out of a file that parsed, so no row is itself
  // suspect — what an unreadable config costs is the rows it would have
  // added. That is reported against the failing file instead, one entry per
  // file, because a broken `.mcp.json` says nothing about `.claude.json`.
  const unreadable = unreadablePaths.map((path) => ({
    providerInstanceId: ProviderInstanceId.make(instanceId),
    harnessDisplayName: displayName,
    configPath: path,
  }));

  return {
    entries,
    unreadable:
      complete || unreadable.length > 0
        ? unreadable
        : // Incomplete with no file to blame: the scopes that need a workspace
          // were never read at all.
          [
            {
              providerInstanceId: ProviderInstanceId.make(instanceId),
              harnessDisplayName: displayName,
            },
          ],
  };
});

const discoverInstanceMcpServers = Effect.fn("McpServerInventory.discoverInstanceMcpServers")(
  function* (
    instanceId: string,
    instance: ProviderInstanceConfig,
    environment: NodeJS.ProcessEnv,
    cwd: string | undefined,
  ): Effect.fn.Return<InstanceDiscovery, never, McpInventoryEnv> {
    // A disabled instance never starts a session, so listing its servers would
    // describe work that cannot happen.
    if (instance.enabled === false) return EMPTY_DISCOVERY;
    if (instance.driver === "claudeAgent") {
      return yield* discoverClaudeMcpServerEntries(instanceId, instance, environment, cwd);
    }
    return EMPTY_DISCOVERY;
  },
);

export const discoverGlobalMcpInventory = Effect.fn(
  "McpServerInventory.discoverGlobalMcpInventory",
)(function* (
  settings: ServerSettings,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<McpServerInventory, never, McpInventoryEnv | ServerConfig.ServerConfig> {
  const providerInstances = deriveProviderInstanceConfigMap(settings);
  const resolvedEnvironment = environment ?? process.env;
  // Sessions resolve a relative `CLAUDE_CONFIG_DIR` against the workspace cwd,
  // so the inventory has to read the same file the runtime will.
  const { cwd } = yield* ServerConfig.ServerConfig;

  const discovered = yield* Effect.forEach(
    Object.entries(providerInstances),
    ([instanceId, instance]) =>
      discoverInstanceMcpServers(instanceId, instance, resolvedEnvironment, cwd),
    { concurrency: DISCOVERY_CONCURRENCY },
  );

  return {
    scannedAt: DateTime.formatIso(yield* DateTime.now),
    servers: discovered
      .flatMap((result) => result.entries)
      .sort(
        (left, right) =>
          left.harnessDisplayName.localeCompare(right.harnessDisplayName) ||
          left.name.localeCompare(right.name),
      ),
    unreadable: discovered.flatMap((result) => result.unreadable),
  };
});
