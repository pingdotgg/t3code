// Fork: Kaluwa's Extensions page. Reads Claude Code's user-scope MCP servers and plugins.
import type {
  ExtensionHealth,
  ExtensionMcpServer,
  ExtensionMcpServerSpec,
  ExtensionPlugin,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { redactCommandLine, redactUrl } from "./redaction.ts";

const StringRecord = Schema.Record(Schema.String, Schema.String);

const ClaudeMcpEntry = Schema.Struct({
  type: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(StringRecord),
  url: Schema.optional(Schema.String),
  headers: Schema.optional(StringRecord),
});
type ClaudeMcpEntry = typeof ClaudeMcpEntry.Type;

// Top-level `mcpServers` is user scope; `projects.<path>.mcpServers` is local scope and stays out.
const ClaudeAccountConfig = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodeClaudeAccountConfig = Schema.decodeUnknownOption(ClaudeAccountConfig);
const decodeClaudeMcpEntry = Schema.decodeUnknownOption(ClaudeMcpEntry);

export const CLAUDE_CONNECTOR_PREFIX = "claude.ai ";

export interface ClaudeMcpListEntry {
  readonly name: string;
  readonly target: string;
  readonly health: ExtensionHealth;
  readonly detail: string | null;
}

const STATUS_PATTERN =
  /^(?:\S+ )?(Connected|Needs authentication|Failed to connect|Connection error|Not configured|Pending approval|Disabled|Rejected)\b(.*)$/;

function claudeStatusHealth(
  keyword: string,
  rest: string,
): Pick<ClaudeMcpListEntry, "health" | "detail"> {
  switch (keyword) {
    case "Connected":
      return rest.includes("tools fetch failed")
        ? { health: "failing", detail: "Connected, but listing its tools failed" }
        : { health: "ok", detail: null };
    case "Needs authentication":
      return { health: "needsAuth", detail: "Needs authentication" };
    case "Failed to connect":
    case "Connection error":
    case "Not configured":
      return { health: "failing", detail: keyword };
    case "Disabled":
      return { health: "disabled", detail: null };
    default:
      return { health: "unknown", detail: keyword };
  }
}

/**
 * Parses `claude mcp list`, which prints `<name>: <command or URL> - <status>` per server. Names
 * can contain spaces and targets can contain " - ", so the status is the last " - " segment that
 * reads as a status. Indented lines after an entry carry the reason it failed.
 */
export function parseClaudeMcpList(output: string): ReadonlyArray<ClaudeMcpListEntry> {
  const entries: Array<ClaudeMcpListEntry> = [];
  for (const line of output.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const previous = entries.at(-1);
    if (/^\s/.test(line) && previous !== undefined) {
      const note = line.trim();
      entries[entries.length - 1] = {
        ...previous,
        detail: previous.detail === null ? note : `${previous.detail}: ${note}`,
      };
      continue;
    }
    const separator = line.indexOf(": ");
    if (separator <= 0) continue;
    const name = line.slice(0, separator);
    const remainder = line.slice(separator + 2);
    let parsed: ClaudeMcpListEntry | undefined;
    for (
      let index = remainder.lastIndexOf(" - ");
      index >= 0;
      index = remainder.lastIndexOf(" - ", index - 1)
    ) {
      const status = STATUS_PATTERN.exec(remainder.slice(index + 3));
      if (status) {
        parsed = {
          name,
          target: remainder.slice(0, index).replace(/ \((?:HTTP|SSE)\)$/, ""),
          ...claudeStatusHealth(status[1] ?? "", status[2] ?? ""),
        };
        break;
      }
      if (index === 0) break;
    }
    if (parsed) entries.push(parsed);
  }
  return entries;
}

export interface ClaudeUserMcpServers {
  readonly servers: ReadonlyArray<ExtensionMcpServer>;
  readonly specs: ReadonlyMap<string, ExtensionMcpServerSpec>;
  readonly skipped: ReadonlyArray<string>;
}

function specFromEntry(entry: ClaudeMcpEntry): ExtensionMcpServerSpec | undefined {
  const type = entry.type ?? (entry.url ? "http" : "stdio");
  if (type === "stdio" && entry.command) {
    return { _tag: "stdio", command: entry.command, args: entry.args ?? [], env: entry.env ?? {} };
  }
  if ((type === "http" || type === "sse") && entry.url) {
    return { _tag: "remote", transport: type, url: entry.url, headers: entry.headers ?? {} };
  }
  return undefined;
}

export function mcpServerFromSpec(
  name: string,
  spec: ExtensionMcpServerSpec,
  overrides: Partial<ExtensionMcpServer> = {},
): ExtensionMcpServer {
  return {
    name,
    transport: spec._tag === "stdio" ? "stdio" : spec.transport,
    target:
      spec._tag === "stdio" ? redactCommandLine(spec.command, spec.args) : redactUrl(spec.url),
    secretNames: Object.keys(spec._tag === "stdio" ? spec.env : spec.headers),
    enabled: true,
    health: "unknown",
    detail: null,
    managedElsewhere: false,
    ...overrides,
  };
}

/**
 * Reads the user-scope servers from `.claude.json`; `undefined` when it isn't JSON. Specs keep
 * secret values and stay server-side.
 */
export function readClaudeUserMcpServers(configText: string): ClaudeUserMcpServers | undefined {
  const servers: Array<ExtensionMcpServer> = [];
  const specs = new Map<string, ExtensionMcpServerSpec>();
  const skipped: Array<string> = [];
  if (configText.trim().length === 0) return { servers, specs, skipped };
  const config = decodeClaudeAccountConfig(configText);
  if (Option.isNone(config)) return undefined;
  for (const [name, raw] of Object.entries(config.value.mcpServers ?? {})) {
    const spec = Option.flatMap(decodeClaudeMcpEntry(raw), (entry) =>
      Option.fromNullishOr(specFromEntry(entry)),
    );
    if (Option.isNone(spec) || name.trim().length === 0) {
      skipped.push(name);
      continue;
    }
    specs.set(name, spec.value);
    servers.push(mcpServerFromSpec(name, spec.value));
  }
  return { servers, specs, skipped };
}

/** Adds health from `claude mcp list`, plus the claude.ai connectors only that listing shows. */
export function withClaudeHealth(
  servers: ReadonlyArray<ExtensionMcpServer>,
  listed: ReadonlyArray<ClaudeMcpListEntry>,
): ReadonlyArray<ExtensionMcpServer> {
  const byName = new Map(listed.map((entry) => [entry.name, entry]));
  const withHealth = servers.map((server) => {
    const entry = byName.get(server.name);
    return entry ? { ...server, health: entry.health, detail: entry.detail } : server;
  });
  const connectors = listed
    .filter((entry) => entry.name.startsWith(CLAUDE_CONNECTOR_PREFIX))
    .map((entry): ExtensionMcpServer => ({
      name: entry.name,
      transport: "http",
      target: redactUrl(entry.target),
      secretNames: [],
      enabled: true,
      health: entry.health,
      detail: entry.detail,
      managedElsewhere: true,
    }));
  return [...withHealth, ...connectors];
}

/** The JSON `claude mcp add-json` takes. It is sent on stdin so secrets stay out of argv. */
export function claudeAddJson(spec: ExtensionMcpServerSpec): string {
  return JSON.stringify(
    spec._tag === "stdio"
      ? { type: "stdio", command: spec.command, args: spec.args, env: spec.env }
      : { type: spec.transport, url: spec.url, headers: spec.headers },
  );
}

const ClaudePluginRow = Schema.Struct({
  id: Schema.String,
  version: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
});
const decodeClaudePluginList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);
const decodeClaudePluginRow = Schema.decodeUnknownOption(ClaudePluginRow);

function errorText(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

/** Maps `claude plugin list --json`. Only user-scope plugins; project and local ones stay out. */
export function parseClaudePluginList(output: string): ReadonlyArray<ExtensionPlugin> | undefined {
  const rows = decodeClaudePluginList(output);
  if (Option.isNone(rows)) return undefined;
  const plugins: Array<ExtensionPlugin> = [];
  const seen = new Set<string>();
  for (const raw of rows.value) {
    const row = decodeClaudePluginRow(raw);
    if (Option.isNone(row)) continue;
    const { id, scope, version, enabled = true, description, errors = [] } = row.value;
    if ((scope ?? "user") !== "user" || seen.has(id) || id.trim().length === 0) continue;
    seen.add(id);
    const at = id.lastIndexOf("@");
    const name = at > 0 ? id.slice(0, at) : id;
    const failures = errors.flatMap((error) => errorText(error) ?? []);
    plugins.push({
      id,
      name,
      marketplace: at > 0 ? id.slice(at + 1) : "",
      version: version && version !== "unknown" ? version : null,
      description: description ?? null,
      enabled,
      health: failures.length > 0 ? "failing" : enabled ? "ok" : "disabled",
      detail: failures.length > 0 ? failures.join("; ") : null,
    });
  }
  return plugins;
}
