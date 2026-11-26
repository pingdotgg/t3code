// Fork: Kaluwa's Extensions page. Reads the MCP server JSON that provider docs hand out.
import type { ExtensionMcpServerSpec } from "@t3tools/contracts";

export interface ParsedMcpServer {
  readonly name: string;
  readonly spec: ExtensionMcpServerSpec;
  /** Env var or header names; their values are stored as secrets. */
  readonly secretNames: readonly string[];
}

export type McpJsonProblem = "syntax" | "unnamed" | "empty";

export interface ParsedMcpJson {
  readonly servers: readonly ParsedMcpServer[];
  /** Names whose entry had neither a command nor a URL. */
  readonly skipped: readonly string[];
  readonly problem: McpJsonProblem | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([name, entry]) =>
      typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"
        ? [[name, String(entry)]]
        : [],
    ),
  );
}

function looksLikeServer(value: Record<string, unknown>) {
  return typeof value.command === "string" || typeof value.url === "string";
}

function parseServer(name: string, value: unknown): ParsedMcpServer | null {
  if (!isRecord(value)) return null;
  if (typeof value.command === "string" && value.command.trim() !== "") {
    const env = stringRecord(value.env);
    return {
      name,
      spec: {
        _tag: "stdio",
        command: value.command.trim(),
        args: Array.isArray(value.args) ? value.args.map(String) : [],
        env,
      },
      secretNames: Object.keys(env),
    };
  }
  const url = typeof value.url === "string" ? value.url : value.serverUrl;
  if (typeof url === "string" && url.trim() !== "") {
    const kind = String(value.type ?? value.transport ?? "").toLowerCase();
    const headers = stringRecord(value.headers);
    return {
      name,
      spec: {
        _tag: "remote",
        transport: kind === "sse" ? "sse" : "http",
        url: url.trim(),
        headers,
      },
      secretNames: Object.keys(headers),
    };
  }
  return null;
}

function parseLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Docs often show only the `"name": { … }` member, without the braces around it.
    return JSON.parse(`{${text.replace(/,\s*$/, "")}}`);
  }
}

/** Accepts `{ "mcpServers": { … } }`, VS Code's `{ "servers": { … } }`, or a bare name map. */
export function parseMcpJson(text: string): ParsedMcpJson {
  const trimmed = text.trim();
  if (trimmed === "") return { servers: [], skipped: [], problem: null };
  let parsed: unknown;
  try {
    parsed = parseLoose(trimmed);
  } catch {
    return { servers: [], skipped: [], problem: "syntax" };
  }
  if (!isRecord(parsed)) return { servers: [], skipped: [], problem: "syntax" };
  const map = isRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : isRecord(parsed.servers)
      ? parsed.servers
      : isRecord(parsed.mcp) && isRecord(parsed.mcp.servers)
        ? parsed.mcp.servers
        : parsed;
  if (looksLikeServer(map)) return { servers: [], skipped: [], problem: "unnamed" };
  const servers: ParsedMcpServer[] = [];
  const skipped: string[] = [];
  for (const [rawName, value] of Object.entries(map)) {
    const name = rawName.trim();
    const server = name === "" ? null : parseServer(name, value);
    if (server) servers.push(server);
    else skipped.push(rawName);
  }
  return { servers, skipped, problem: servers.length === 0 ? "empty" : null };
}

/** Splits a command line on spaces, keeping quoted parts whole. */
export function splitCommandLine(text: string): readonly string[] {
  const parts: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    parts.push(match[1] ?? match[2] ?? match[3]!);
  }
  return parts;
}
