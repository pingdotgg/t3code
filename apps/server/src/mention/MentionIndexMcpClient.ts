// Short-lived MCP sessions for mention indexing; JSON-RPC payloads stay opaque.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off globalErrorInEffectFailure:off globalErrorInEffectCatch:off globalFetchInEffect:off tryCatchInEffectGen:off effectFnOpportunity:off processEnvInEffect:off
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";

import type {
  MentionIndexFigmaSettings,
  MentionIndexJiraSettings,
  ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_REQUEST_TIMEOUT = Duration.seconds(30);

function parseJsonOrNull(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export class MentionIndexMcpError extends Schema.TaggedError<MentionIndexMcpError>()(
  "MentionIndexMcpError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type MentionMcpKind = "jira" | "figma";

export interface MentionMcpStdioConfig {
  readonly transport: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface MentionMcpHttpConfig {
  readonly transport: "http";
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type MentionMcpServerConfig = MentionMcpStdioConfig | MentionMcpHttpConfig;

export interface MentionMcpToolSession {
  readonly listTools: () => Effect.Effect<ReadonlyArray<{ readonly name: string }>, Error>;
  readonly callTool: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, Error>;
}

export class MentionIndexMcpClient extends Context.Service<
  MentionIndexMcpClient,
  {
    readonly resolveServer: (input: {
      readonly kind: MentionMcpKind;
      readonly serverName?: string | undefined;
    }) => Effect.Effect<MentionMcpServerConfig | null>;
    readonly withSession: <A, E>(
      config: MentionMcpServerConfig,
      use: (session: MentionMcpToolSession) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | Error>;
    readonly readSettings: (projectId: ProjectId | null) => Effect.Effect<{
      readonly jira: MentionIndexJiraSettings | undefined;
      readonly figma: MentionIndexFigmaSettings | undefined;
    }>;
  }
>()("t3/mention/MentionIndexMcpClient") {}

const CursorMcpFile = Schema.Struct({
  mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const decodeCursorMcp = Schema.decodeUnknownOption(CursorMcpFile);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayField(record: Record<string, unknown>, key: string): ReadonlyArray<string> {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function envField(record: Record<string, unknown>): Record<string, string> {
  const env = asRecord(record.env);
  if (env === null) return {};
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") next[key] = value;
  }
  return next;
}

function headersField(record: Record<string, unknown>): Record<string, string> {
  const headers = asRecord(record.headers) ?? asRecord(record.http_headers);
  if (headers === null) return {};
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") next[key] = value;
  }
  return next;
}

function parseServerEntry(name: string, value: unknown): MentionMcpServerConfig | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (record.enabled === false) return null;
  const url = stringField(record, "url");
  if (url !== undefined) {
    return {
      transport: "http",
      name,
      url,
      headers: headersField(record),
    };
  }
  const command = stringField(record, "command");
  if (command === undefined) return null;
  return {
    transport: "stdio",
    name,
    command,
    args: stringArrayField(record, "args"),
    env: envField(record),
  };
}

function matchesKind(name: string, kind: MentionMcpKind): boolean {
  const folded = name.toLowerCase();
  if (kind === "jira") return folded.includes("jira") || folded.includes("atlassian");
  return folded.includes("figma");
}

function pickServer(
  entries: ReadonlyArray<MentionMcpServerConfig>,
  kind: MentionMcpKind,
  serverName: string | undefined,
): MentionMcpServerConfig | null {
  if (serverName !== undefined) {
    const exact = entries.find((entry) => entry.name === serverName);
    const folded = serverName.toLowerCase();
    const named = exact ?? entries.find((entry) => entry.name.toLowerCase() === folded) ?? null;
    // Named picks still require a jira/figma heuristic so browse RPCs cannot spawn an unrelated MCP.
    return named !== null && matchesKind(named.name, kind) ? named : null;
  }
  return entries.find((entry) => matchesKind(entry.name, kind)) ?? null;
}

function unquoteToml(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse a TOML inline table of string values: `{ "KEY" = "value", OTHER = "x" }`. */
function parseTomlInlineStringTable(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return {};
  const next: Record<string, string> = {};
  const inner = trimmed.slice(1, -1);
  const pair =
    /(?:"([^"]+)"|([A-Za-z0-9_]+))\s*=\s*(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s,]+))/gu;
  for (const match of inner.matchAll(pair)) {
    const key = match[1] ?? match[2];
    const value = match[3] ?? match[4] ?? match[5];
    if (key === undefined || value === undefined) continue;
    next[key] = value;
  }
  return next;
}

/** Parse a TOML string array without rewriting characters inside quotes. */
function parseTomlStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  const asJson = parseJsonOrNull(trimmed);
  if (Array.isArray(asJson)) {
    return asJson.filter((entry): entry is string => typeof entry === "string");
  }
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const items: string[] = [];
  const item = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'/gu;
  for (const match of trimmed.slice(1, -1).matchAll(item)) {
    const value = match[1] ?? match[2];
    if (value !== undefined) items.push(value);
  }
  return items;
}

function mcpErrorMessage(error: unknown, fallback: string): string {
  const message = asRecord(error)?.message;
  return typeof message === "string" ? message : fallback;
}

type StdioPending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

/** Test helper: settle one stdio JSON-RPC line against pending request waiters. */
export function settleStdioMcpResponseLine(
  line: string,
  pending: Map<number, StdioPending>,
  serverName: string,
): void {
  const envelope = asRecord(parseJsonOrNull(line));
  if (envelope === null) return;
  if (typeof envelope.id !== "number") return;
  const waiter = pending.get(envelope.id);
  if (!waiter) return;
  pending.delete(envelope.id);
  if (envelope.error !== undefined) {
    waiter.reject(new Error(mcpErrorMessage(envelope.error, `MCP error from ${serverName}`)));
    return;
  }
  waiter.resolve(envelope.result);
}

function headersFromEnvMap(
  envHeaderNames: Readonly<Record<string, string>>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [header, envName] of Object.entries(envHeaderNames)) {
    const value = process.env[envName];
    if (typeof value === "string" && value.length > 0) next[header] = value;
  }
  return next;
}

const MCP_SERVER_TABLE_KEYS = new Set(["env", "http_headers", "env_http_headers"]);

type CodexMcpServerDraft = {
  name: string;
  fields: Record<string, string>;
  tables: Record<string, Record<string, string>>;
  activeTable: string | null;
};

/**
 * Lightweight Codex `config.toml` `[mcp_servers.*]` reader.
 * Skips `enabled = false`; carries env / http_headers / bearer_token_env_var.
 */
export function parseCodexMcpServers(raw: string): ReadonlyArray<MentionMcpServerConfig> {
  const entries: MentionMcpServerConfig[] = [];
  let current: CodexMcpServerDraft | null = null;
  const mergeTable = (inline: string | undefined, table: Record<string, string> | undefined) => ({
    ...(inline ? parseTomlInlineStringTable(inline) : {}),
    ...table,
  });
  const flush = () => {
    if (current === null) return;
    const fields = current.fields;
    if (fields.enabled === "false") {
      current = null;
      return;
    }
    const command = fields.command;
    const url = fields.url;
    const env = mergeTable(fields.env, current.tables.env);
    const httpHeaders = mergeTable(fields.http_headers, current.tables.http_headers);
    const envHttpHeaders = headersFromEnvMap(
      mergeTable(fields.env_http_headers, current.tables.env_http_headers),
    );
    const bearerEnv = fields.bearer_token_env_var;
    const bearer =
      bearerEnv !== undefined && bearerEnv.length > 0 ? process.env[bearerEnv] : undefined;
    const headers: Record<string, string> = {
      ...httpHeaders,
      ...envHttpHeaders,
      ...(typeof bearer === "string" && bearer.length > 0
        ? { Authorization: `Bearer ${bearer}` }
        : {}),
    };
    if (url) {
      entries.push({
        transport: "http",
        name: current.name,
        url,
        headers,
      });
    } else if (command) {
      const args = fields.args ? parseTomlStringArray(fields.args) : [];
      entries.push({
        transport: "stdio",
        name: current.name,
        command,
        args,
        env,
      });
    }
    current = null;
  };
  for (const line of raw.split(/\r?\n/u)) {
    const arraySection = line.match(/^\[\[([^\]]+)\]\]\s*$/u);
    if (arraySection) {
      flush();
      continue;
    }
    const section = line.match(/^\[([^\]]+)\]\s*$/u);
    if (section) {
      const header = section[1]!.replace(/^"|"$/g, "");
      const mcpTable = /^mcp_servers\.(.+)\.(env|http_headers|env_http_headers)$/u.exec(header);
      if (mcpTable !== null && MCP_SERVER_TABLE_KEYS.has(mcpTable[2]!)) {
        const name = mcpTable[1]!.replace(/^"|"$/g, "");
        if (current === null || current.name !== name) {
          flush();
          current = { name, fields: {}, tables: {}, activeTable: mcpTable[2]! };
        } else {
          current.activeTable = mcpTable[2]!;
        }
        current.tables[mcpTable[2]!] ??= {};
        continue;
      }
      const mcpSection = /^mcp_servers\.(.+)$/u.exec(header);
      if (mcpSection !== null) {
        const name = mcpSection[1]!.replace(/^"|"$/g, "");
        if (current === null || current.name !== name) {
          flush();
          current = { name, fields: {}, tables: {}, activeTable: null };
        } else {
          current.activeTable = null;
        }
        continue;
      }
      flush();
      continue;
    }
    if (current === null) continue;
    const field = line.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/u);
    if (!field) continue;
    const key = unquoteToml(field[1]!);
    const value = unquoteToml(field[2]!);
    if (current.activeTable !== null) {
      current.tables[current.activeTable] ??= {};
      current.tables[current.activeTable]![key] = value;
    } else {
      current.fields[key] = value;
    }
  }
  flush();
  return entries;
}

/** Parse SSE `data:` JSON-RPC frames; return the envelope matching `requestId` when set. */
function parseMcpSsePayload(text: string, requestId?: number): unknown {
  const events: unknown[] = [];
  let dataLines: string[] = [];
  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n").trim();
    dataLines = [];
    if (payload.length === 0 || payload === "[DONE]") return;
    const parsed = parseJsonOrNull(payload);
    if (parsed !== null) events.push(parsed);
  };
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) {
      flushEvent();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  flushEvent();

  if (requestId !== undefined) {
    const matched = events.find((event) => {
      const record = asRecord(event);
      return record !== null && record.id === requestId;
    });
    if (matched !== undefined) return matched;
  }
  return events.find((event) => asRecord(event)?.id !== undefined) ?? events[0] ?? null;
}

export function parseMcpHttpResponseBody(input: {
  readonly contentType: string | null;
  readonly text: string;
  readonly requestId?: number;
}): unknown {
  const contentType = input.contentType?.toLowerCase() ?? "";
  const isSse = contentType.includes("text/event-stream");
  if (isSse) return parseMcpSsePayload(input.text, input.requestId);
  if (input.text.trim().length === 0) return null;
  return parseJsonOrNull(input.text);
}

type StdioResource = {
  readonly child: NodeChildProcess.ChildProcess;
  readonly lines: NodeReadline.Interface;
  readonly stdin: NodeJS.WritableStream;
  readonly pending: Map<number, StdioPending>;
  closed: boolean;
  readonly rejectPending: (reason: Error) => void;
  readonly onChildError: (cause: Error) => void;
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const home = yield* HostProcess.HomeDirectory;

  const readJsonServers = Effect.fn("MentionIndexMcpClient.readJsonServers")(function* (
    filePath: string,
  ) {
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [] as MentionMcpServerConfig[];
    const raw = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return [];
    const parsed = parseJsonOrNull(raw);
    if (parsed === null) return [];
    const decoded = decodeCursorMcp(parsed);
    const servers = Option.isSome(decoded) ? (decoded.value.mcpServers ?? {}) : asRecord(parsed);
    if (servers === null) return [];
    const source =
      "mcpServers" in (asRecord(parsed) ?? {})
        ? ((asRecord(parsed)?.mcpServers as Record<string, unknown> | undefined) ?? servers)
        : servers;
    const entries: MentionMcpServerConfig[] = [];
    for (const [name, value] of Object.entries(source)) {
      const parsedEntry = parseServerEntry(name, value);
      if (parsedEntry) entries.push(parsedEntry);
    }
    return entries;
  });

  const resolveServer = Effect.fn("MentionIndexMcpClient.resolveServer")(function* (input: {
    readonly kind: MentionMcpKind;
    readonly serverName?: string | undefined;
  }) {
    // Trust boundary: only user-level MCP configs. Project-local `.cursor/mcp.json`
    // can ship arbitrary commands and must not be discovered or executed.
    const candidates: MentionMcpServerConfig[] = [];
    const files = [
      path.join(home, ".cursor", "mcp.json"),
      path.join(home, ".claude.json"),
      path.join(home, ".config", "Claude", "claude_desktop_config.json"),
    ];
    for (const file of files) {
      candidates.push(...(yield* readJsonServers(file)));
    }
    const codexRaw = yield* fileSystem
      .readFileString(path.join(home, ".codex", "config.toml"))
      .pipe(Effect.orElseSucceed(() => ""));
    if (codexRaw.trim().length > 0) {
      candidates.push(...parseCodexMcpServers(codexRaw));
    }
    return pickServer(candidates, input.kind, input.serverName);
  });

  const withStdioSession = Effect.fn("MentionIndexMcpClient.withStdioSession")(function* <A, E>(
    config: MentionMcpStdioConfig,
    use: (session: MentionMcpToolSession) => Effect.Effect<A, E>,
  ) {
    const env = yield* HostProcess.Environment;
    const platform = yield* HostProcess.Platform;
    const spawnEnv: Record<string, string> = {
      PATH: env.PATH ?? env.Path ?? env.path ?? "",
    };
    if (platform === "win32") {
      const windowsKeys = [
        "SystemRoot",
        "SYSTEMROOT",
        "USERPROFILE",
        "APPDATA",
        "PATHEXT",
      ] as const;
      for (const key of windowsKeys) {
        const value = env[key];
        if (typeof value === "string" && value.length > 0) spawnEnv[key] = value;
      }
    }
    Object.assign(spawnEnv, config.env);

    // Windows .cmd/.bat MCP shims need shell dispatch; keep the env minimal so unrelated secrets stay out.
    const resolved = yield* resolveSpawnCommand(config.command, [...config.args], {
      env: spawnEnv,
      extendEnv: false,
    });

    return yield* Effect.acquireUseRelease(
      Effect.callback<StdioResource, Error>((resume) => {
        let settled = false;
        const pending = new Map<number, StdioPending>();
        let closed = false;
        const rejectPending = (reason: Error) => {
          if (closed) return;
          closed = true;
          for (const waiter of pending.values()) {
            waiter.reject(reason);
          }
          pending.clear();
        };
        const onChildError = (cause: Error) => {
          const mapped =
            (cause as NodeJS.ErrnoException).code === "ENOENT"
              ? new Error(`MCP server ${config.name} binary not found: ${config.command}`, {
                  cause,
                })
              : cause;
          if (!settled) {
            settled = true;
            resume(Effect.fail(mapped));
            return;
          }
          rejectPending(mapped);
        };
        const child = NodeChildProcess.spawn(resolved.command, [...resolved.args], {
          env: spawnEnv,
          shell: resolved.shell,
          // Ignore stderr so a full pipe cannot block the child.
          stdio: ["pipe", "pipe", "ignore"],
        });
        // Always listen: an unhandled child `error` (e.g. ENOENT) crashes the process.
        child.on("error", onChildError);
        if (child.stdin === null || child.stdout === null) {
          child.kill();
          onChildError(new Error(`MCP server ${config.name} did not expose stdio.`));
          return;
        }
        const lines = NodeReadline.createInterface({ input: child.stdout });
        const succeed = () => {
          if (settled) return;
          settled = true;
          resume(
            Effect.succeed({
              child,
              lines,
              stdin: child.stdin!,
              pending,
              get closed() {
                return closed;
              },
              set closed(value: boolean) {
                closed = value;
              },
              rejectPending,
              onChildError,
            }),
          );
        };
        child.once("spawn", succeed);
        void setImmediate(() => {
          if (!settled && child.pid !== undefined) succeed();
        });
      }),
      (resource) => {
        const { child, lines, stdin, pending, rejectPending, onChildError } = resource;
        let nextId = 1;

        const onLine = (line: string) => {
          settleStdioMcpResponseLine(line, pending, config.name);
        };
        lines.on("line", onLine);
        stdin.on("error", (cause) => {
          rejectPending(cause instanceof Error ? cause : new Error(String(cause)));
        });
        child.on("close", () => {
          rejectPending(new Error(`MCP server ${config.name} closed.`));
        });
        lines.on("close", () => {
          rejectPending(new Error(`MCP server ${config.name} closed.`));
        });

        const request = (method: string, params: unknown) => {
          const id = nextId++;
          return Effect.tryPromise({
            try: () =>
              new Promise<unknown>((resolve, reject) => {
                if (resource.closed) {
                  reject(new Error(`MCP server ${config.name} closed.`));
                  return;
                }
                pending.set(id, { resolve, reject });
                stdin.write(
                  `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
                  (error) => {
                    if (error) {
                      pending.delete(id);
                      reject(error);
                    }
                  },
                );
              }),
            catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
          }).pipe(
            Effect.timeoutOrElse({
              duration: MCP_REQUEST_TIMEOUT,
              orElse: () => {
                pending.delete(id);
                return Effect.fail(new Error(`MCP request timed out talking to ${config.name}`));
              },
            }),
          );
        };

        const session: MentionMcpToolSession = {
          listTools: () =>
            request("tools/list", {}).pipe(
              Effect.map((result) => {
                const tools = asRecord(result)?.tools;
                if (!Array.isArray(tools)) return [];
                return tools.flatMap((tool) => {
                  const name = stringField(asRecord(tool) ?? {}, "name");
                  return name === undefined ? [] : [{ name }];
                });
              }),
            ),
          callTool: (name, args) => request("tools/call", { name, arguments: args }),
        };

        return request("initialize", {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3code-mention-index", version: "1" },
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              stdin.write(
                `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
              );
            }),
          ),
          Effect.andThen(use(session)),
          Effect.ensuring(
            Effect.sync(() => {
              lines.off("line", onLine);
              child.off("error", onChildError);
              rejectPending(new Error(`MCP server ${config.name} closed.`));
              child.kill();
            }),
          ),
        );
      },
      ({ child, lines }) =>
        Effect.sync(() => {
          lines.close();
          if (!child.killed) child.kill();
        }),
    );
  });

  const openHttpSession = Effect.fn("MentionIndexMcpClient.openHttpSession")(function* (
    config: MentionMcpHttpConfig,
  ) {
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    let nextId = 1;

    const headers = () => ({
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...config.headers,
      ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
    });

    const post = Effect.fn("MentionIndexMcpClient.httpPost")(function* (
      body: unknown,
      requestId?: number,
    ) {
      return yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(config.url, {
            method: "POST",
            headers: headers(),
            body: JSON.stringify(body),
            signal,
          });
          sessionId = response.headers.get("mcp-session-id") ?? sessionId;
          const text = await response.text();
          if (!response.ok) {
            throw new Error(`MCP HTTP ${response.status} from ${config.name}`);
          }
          return parseMcpHttpResponseBody({
            contentType: response.headers.get("content-type"),
            text,
            ...(requestId !== undefined ? { requestId } : {}),
          });
        },
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
    });

    const request = Effect.fn("MentionIndexMcpClient.httpRequest")(function* (
      method: string,
      params: unknown,
    ) {
      const id = nextId++;
      const response = yield* post({ jsonrpc: "2.0", id, method, params }, id).pipe(
        Effect.timeoutOrElse({
          duration: MCP_REQUEST_TIMEOUT,
          orElse: () => Effect.fail(new Error(`MCP request timed out talking to ${config.name}`)),
        }),
      );
      const envelope = asRecord(response);
      if (envelope === null) {
        return yield* Effect.fail(new Error(`Empty MCP response from ${config.name}`));
      }
      const result = asRecord(envelope.result);
      const version = stringField(result ?? {}, "protocolVersion");
      if (version) protocolVersion = version;
      if (envelope.error !== undefined) {
        return yield* Effect.fail(
          new Error(mcpErrorMessage(envelope.error, `MCP error from ${config.name}`)),
        );
      }
      return envelope.result;
    });

    yield* request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "t3code-mention-index", version: "1" },
    });
    yield* post({ jsonrpc: "2.0", method: "notifications/initialized" });

    return {
      listTools: () =>
        request("tools/list", {}).pipe(
          Effect.map((result) => {
            const tools = asRecord(result)?.tools;
            if (!Array.isArray(tools)) return [];
            return tools.flatMap((tool) => {
              const name = stringField(asRecord(tool) ?? {}, "name");
              return name === undefined ? [] : [{ name }];
            });
          }),
        ),
      callTool: (name, args) => request("tools/call", { name, arguments: args }),
    } satisfies MentionMcpToolSession;
  });

  const withHttpSession = <A, E>(
    config: MentionMcpHttpConfig,
    use: (session: MentionMcpToolSession) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | Error> => openHttpSession(config).pipe(Effect.andThen(use));

  return MentionIndexMcpClient.of({
    resolveServer,
    withSession: (config, use) =>
      config.transport === "stdio" ? withStdioSession(config, use) : withHttpSession(config, use),
    readSettings: Effect.fn("MentionIndexMcpClient.readSettings")(function* (
      projectId: ProjectId | null,
    ) {
      return yield* settings.getSettings.pipe(
        Effect.map((current) => {
          const mentionIndex = resolveProjectSettings(current, projectId).settings.mentionIndex;
          return {
            jira: mentionIndex.jira,
            figma: mentionIndex.figma,
          };
        }),
        Effect.orElseSucceed(() => ({ jira: undefined, figma: undefined })),
      );
    }),
  });
});

export const layer = Layer.effect(MentionIndexMcpClient, make);

/** Test helper: parse a Cursor-style mcpServers map without touching disk. */
export function parseMentionMcpServers(
  mcpServers: Readonly<Record<string, unknown>>,
): ReadonlyArray<MentionMcpServerConfig> {
  return Object.entries(mcpServers).flatMap(([name, value]) => {
    const parsed = parseServerEntry(name, value);
    return parsed === null ? [] : [parsed];
  });
}

export function pickMentionMcpServer(
  entries: ReadonlyArray<MentionMcpServerConfig>,
  kind: MentionMcpKind,
  serverName?: string,
): MentionMcpServerConfig | null {
  return pickServer(entries, kind, serverName);
}
