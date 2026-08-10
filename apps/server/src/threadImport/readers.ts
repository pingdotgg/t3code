// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadImportProvider,
} from "@t3tools/contracts";

export const MAX_IMPORT_MESSAGES = 2_000;
const MAX_IMPORT_FILE_BYTES = 12 * 1024 * 1024;
const MAX_IMPORT_TEXT_CHARS = 120_000;
const MAX_WALK_DEPTH = 7;

export interface ImportedTranscriptMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
}

export interface ImportedConversation {
  readonly provider: ThreadImportProvider;
  readonly providerInstanceId: ProviderInstanceId;
  readonly externalSessionId: string;
  readonly title: string;
  readonly sourceCwd: string;
  readonly updatedAt: string;
  readonly model: string | undefined;
  readonly messages: ReadonlyArray<ImportedTranscriptMessage>;
  readonly resumeCursor: unknown | null;
  readonly warnings: ReadonlyArray<string>;
}

export interface ProviderImportConfig {
  readonly provider: ThreadImportProvider;
  readonly providerInstanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly defaultModel: string | undefined;
  readonly projectRoot: string;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface ExtractedMessage extends ImportedTranscriptMessage {
  readonly sourceKey: string | undefined;
  readonly chunk: boolean;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function firstString(value: unknown, keys: ReadonlyArray<string>, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record !== undefined) {
    for (const key of keys) {
      const candidate = stringValue(record[key]);
      if (candidate !== undefined) return candidate;
    }
    for (const child of Object.values(record)) {
      const nested = firstString(child, keys, depth + 1);
      if (nested !== undefined) return nested;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const nested = firstString(child, keys, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function timestampFor(value: unknown, fallback: string): string {
  const candidate = firstString(value, ["timestamp", "createdAt", "created_at", "time"]);
  if (candidate !== undefined && !Number.isNaN(Date.parse(candidate))) {
    return new Date(candidate).toISOString();
  }
  const record = asRecord(value);
  const numeric = record?.timestamp;
  if (typeof numeric === "number" && Number.isFinite(numeric)) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallback;
}

function textParts(value: unknown, depth = 0): Array<string> {
  if (depth > 5) return [];
  if (typeof value === "string") return value.trim().length > 0 ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((child) => textParts(child, depth + 1));
  const record = asRecord(value);
  if (record === undefined) return [];

  for (const key of ["text", "text_delta", "data", "output", "result"]) {
    const direct = textParts(record[key], depth + 1);
    if (direct.length > 0) return direct;
  }
  for (const key of ["content", "parts", "message", "delta", "update", "payload", "item"]) {
    const nested = textParts(record[key], depth + 1);
    if (nested.length > 0) return nested;
  }
  return [];
}

function roleFor(value: unknown): ExtractedMessage["role"] | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const sessionUpdate = stringValue(record.sessionUpdate)?.toLowerCase();
  if (sessionUpdate === "user_message_chunk") return "user";
  if (sessionUpdate === "agent_message_chunk") return "assistant";

  const role = firstString(record, ["role", "author"])?.toLowerCase();
  if (role === "user" || role === "human") return "user";
  if (role === "assistant" || role === "agent") return "assistant";
  if (role === "system") return "system";

  const type = stringValue(record.type)?.toLowerCase();
  if (type === "user" || type === "user_message" || type === "human_message") return "user";
  if (type === "assistant" || type === "agent_message" || type === "assistant_message") {
    return "assistant";
  }
  if (type === "system" || type === "system_message") return "system";
  return undefined;
}

function messageFromRecord(
  value: unknown,
  fallbackTimestamp: string,
): ExtractedMessage | undefined {
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const role =
    roleFor(record) ??
    roleFor(record.message) ??
    roleFor(record.update) ??
    roleFor(record.payload) ??
    roleFor(record.item);
  if (role === undefined) return undefined;
  const text = textParts(
    record.message ?? record.update ?? record.content ?? record.payload ?? record.item ?? record,
  )
    .join("")
    .trim();
  if (text.length === 0) return undefined;
  return {
    role,
    text: text.slice(0, MAX_IMPORT_TEXT_CHARS),
    createdAt: timestampFor(record, fallbackTimestamp),
    sourceKey: firstString(record, ["id", "messageId", "message_id", "requestId"]),
    chunk: stringValue(record.sessionUpdate)?.endsWith("_chunk") === true,
  };
}

interface ParsedJsonRecords {
  readonly records: ReadonlyArray<unknown>;
  readonly warnings: ReadonlyArray<string>;
}

function parseJsonRecords(contents: string): ParsedJsonRecords {
  const trimmed = contents.trim();
  if (trimmed.length === 0) return { records: [], warnings: [] };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (Array.isArray(parsed)) return { records: parsed, warnings: [] };
    if (record !== undefined && Array.isArray(record.messages)) {
      return { records: record.messages, warnings: [] };
    }
    return { records: [parsed], warnings: [] };
  } catch {
    const records: Array<unknown> = [];
    let malformedCount = 0;
    for (const line of contents.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate.length === 0) continue;
      try {
        records.push(JSON.parse(candidate) as unknown);
      } catch {
        malformedCount += 1;
      }
    }
    return {
      records,
      warnings:
        malformedCount === 0 ? [] : [`Skipped ${malformedCount} malformed provider record(s).`],
    };
  }
}

function recordWarnings(records: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const warnings: string[] = [];
  const unknownRecords = records.filter((record) => {
    const type = firstString(record, ["type"]);
    return type?.toLowerCase().startsWith("future_") || type?.toLowerCase() === "unknown";
  }).length;
  if (unknownRecords > 0) {
    warnings.push(`Skipped ${unknownRecords} provider record(s) from an unknown version.`);
  }
  return warnings;
}

function normalizeMessages(
  records: ReadonlyArray<unknown>,
  fallbackTimestamp: string,
): ReadonlyArray<ImportedTranscriptMessage> {
  const extracted: Array<ExtractedMessage> = [];
  for (const record of records) {
    const message = messageFromRecord(record, fallbackTimestamp);
    if (message === undefined) continue;
    const previous = extracted.at(-1);
    if (
      previous !== undefined &&
      previous.role === message.role &&
      ((message.chunk && previous.chunk) ||
        (message.sourceKey !== undefined && message.sourceKey === previous.sourceKey))
    ) {
      extracted[extracted.length - 1] = {
        ...previous,
        text: `${previous.text}${message.text}`.slice(0, MAX_IMPORT_TEXT_CHARS),
      };
      continue;
    }
    extracted.push(message);
  }
  return extracted.map(({ role, text, createdAt }) => ({ role, text, createdAt }));
}

function titleFor(messages: ReadonlyArray<ImportedTranscriptMessage>, fallback: string): string {
  const firstUser = messages.find((message) => message.role === "user");
  const title = firstUser?.text.replace(/\s+/g, " ").trim();
  if (title !== undefined && title.length > 0) return title.slice(0, 96);
  return fallback;
}

function resolveHome(value: unknown): string {
  const configured = stringValue(value) ?? "";
  const expanded = configured.startsWith("~/")
    ? NodePath.join(NodeOS.homedir(), configured.slice(2))
    : configured;
  return NodePath.resolve(expanded.length > 0 ? expanded : NodeOS.homedir());
}

function configString(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return stringValue(config[key]);
}

function environmentValue(
  environment: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return stringValue(environment[name]) ?? stringValue(process.env[name]);
}

function providerHome(input: ProviderImportConfig): string {
  const configuredHome = configString(input.config, "homePath");
  if (configuredHome !== undefined) return resolveHome(configuredHome);

  const environmentHome =
    input.provider === "claudeAgent"
      ? environmentValue(input.environment, "CLAUDE_CONFIG_DIR")
      : input.provider === "codex"
        ? environmentValue(input.environment, "CODEX_HOME")
        : input.provider === "cursor"
          ? environmentValue(input.environment, "CURSOR_HOME")
          : environmentValue(input.environment, "GROK_HOME");
  if (environmentHome !== undefined) return resolveHome(environmentHome);

  const defaultDirectory =
    input.provider === "claudeAgent"
      ? ".claude"
      : input.provider === "codex"
        ? ".codex"
        : input.provider === "cursor"
          ? ".cursor"
          : ".grok";
  return NodePath.join(NodeOS.homedir(), defaultDirectory);
}

async function listFiles(
  roots: ReadonlyArray<string>,
  extensions: ReadonlySet<string>,
): Promise<string[]> {
  const files: string[] = [];
  const walk = async (root: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await NodeFSP.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(root, entry.name);
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
      } else if (entry.isFile() && extensions.has(NodePath.extname(entry.name).toLowerCase())) {
        files.push(child);
      }
    }
  };
  for (const root of roots) await walk(root, 0);
  return files;
}

async function readJsonTranscript(path: string): Promise<
  | {
      readonly records: ReadonlyArray<unknown>;
      readonly updatedAt: string;
      readonly warnings: ReadonlyArray<string>;
    }
  | undefined
> {
  try {
    const stats = await NodeFSP.stat(path);
    if (stats.size > MAX_IMPORT_FILE_BYTES) return undefined;
    const contents = await NodeFSP.readFile(path, "utf8");
    const parsed = parseJsonRecords(contents);
    return {
      records: parsed.records,
      updatedAt: new Date(stats.mtimeMs).toISOString(),
      warnings: parsed.warnings,
    };
  } catch {
    return undefined;
  }
}

function projectMatches(sourceCwd: string, projectRoot: string): boolean {
  return (
    NodePath.isAbsolute(sourceCwd) && NodePath.resolve(sourceCwd) === NodePath.resolve(projectRoot)
  );
}

function makeConversation(input: {
  readonly config: ProviderImportConfig;
  readonly externalSessionId: string;
  readonly records: ReadonlyArray<unknown>;
  readonly updatedAt: string;
  readonly resumeCursor: unknown | null;
  readonly fallbackTitle: string;
  readonly warnings?: ReadonlyArray<string>;
}): ImportedConversation | undefined {
  const sourceCwd = firstString(input.records, [
    "cwd",
    "workspaceRoot",
    "workspace_root",
    "projectPath",
  ]);
  if (sourceCwd === undefined || !projectMatches(sourceCwd, input.config.projectRoot))
    return undefined;
  const messages = normalizeMessages(input.records, input.updatedAt);
  if (messages.length === 0) return undefined;
  const title = firstString(input.records, ["title", "name", "summary"]);
  const model = firstString(input.records, ["model", "modelSlug", "model_slug"]);
  return {
    provider: input.config.provider,
    providerInstanceId: input.config.providerInstanceId,
    externalSessionId: input.externalSessionId,
    title: title?.slice(0, 96) ?? titleFor(messages, input.fallbackTitle),
    sourceCwd,
    updatedAt: input.updatedAt,
    model,
    messages,
    resumeCursor: input.resumeCursor,
    warnings: input.warnings ?? [],
  };
}

async function discoverJsonProvider(
  input: ProviderImportConfig,
): Promise<ReadonlyArray<ImportedConversation>> {
  const home = providerHome(input);
  const roots =
    input.provider === "claudeAgent"
      ? [NodePath.join(home, "projects")]
      : input.provider === "codex"
        ? [NodePath.join(home, "sessions"), NodePath.join(home, "archived_sessions")]
        : input.provider === "grok"
          ? [
              NodePath.join(home, "sessions"),
              NodePath.join(home, "acp"),
              NodePath.join(home, "agent"),
            ]
          : [
              NodePath.join(home, "chats"),
              NodePath.join(home, "projects"),
              NodePath.join(home, "agent"),
            ];
  const files = await listFiles(roots, new Set([".json", ".jsonl", ".ndjson"]));
  const conversations: Array<ImportedConversation> = [];
  for (const file of files) {
    const transcript = await readJsonTranscript(file);
    if (transcript === undefined) continue;
    const externalSessionId =
      firstString(transcript.records, ["sessionId", "session_id", "threadId", "thread_id", "id"]) ??
      NodePath.basename(file).replace(/\.(jsonl?|ndjson)$/i, "");
    const resumeCursor =
      input.provider === "claudeAgent"
        ? isUuid(externalSessionId)
          ? { resume: externalSessionId }
          : null
        : input.provider === "codex"
          ? { threadId: externalSessionId }
          : { schemaVersion: 1, sessionId: externalSessionId };
    const resumeWarning =
      input.provider === "claudeAgent" && resumeCursor === null
        ? "Claude session UUID was not found; imported as transcript-only."
        : undefined;
    const conversation = makeConversation({
      config: input,
      externalSessionId,
      records: transcript.records,
      updatedAt: transcript.updatedAt,
      resumeCursor,
      fallbackTitle: `${input.displayName} conversation`,
      warnings: [...transcript.warnings, ...recordWarnings(transcript.records)],
    });
    if (conversation !== undefined) {
      conversations.push(
        resumeWarning === undefined
          ? conversation
          : { ...conversation, warnings: [...conversation.warnings, resumeWarning] },
      );
    }
  }
  return conversations;
}

async function readGrokSqliteRecords(path: string): Promise<ReadonlyArray<unknown>> {
  try {
    if (process.versions.bun !== undefined) {
      const sqlite = await import("bun:sqlite");
      const database = new sqlite.Database(path, { readonly: true });
      const tables = database
        .query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as ReadonlyArray<JsonRecord>;
      const rows: Array<unknown> = [];
      for (const table of tables) {
        const name = stringValue(table.name);
        if (name === undefined || !/session|message|conversation|event|update/i.test(name))
          continue;
        const quoted = `"${name.replaceAll('"', '""')}"`;
        rows.push(...(database.query(`SELECT * FROM ${quoted}`).all() as ReadonlyArray<unknown>));
      }
      database.close();
      return rows;
    }

    const sqlite = await import("node:sqlite");
    const database = new sqlite.DatabaseSync(path, { readOnly: true });
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as ReadonlyArray<JsonRecord>;
    const rows: Array<unknown> = [];
    for (const table of tables) {
      const name = stringValue(table.name);
      if (name === undefined || !/session|message|conversation|event|update/i.test(name)) continue;
      const quoted = `"${name.replaceAll('"', '""')}"`;
      rows.push(...(database.prepare(`SELECT * FROM ${quoted}`).all() as ReadonlyArray<unknown>));
    }
    database.close();
    return rows;
  } catch {
    return [];
  }
}

async function discoverGrok(
  input: ProviderImportConfig,
): Promise<ReadonlyArray<ImportedConversation>> {
  const home = providerHome(input);
  const files = await listFiles(
    [NodePath.join(home, "sessions"), NodePath.join(home, "store"), NodePath.join(home, "acp")],
    new Set([".db", ".sqlite", ".sqlite3"]),
  );
  const conversations: Array<ImportedConversation> = [];
  for (const file of files) {
    let stats;
    try {
      stats = await NodeFSP.stat(file);
    } catch {
      continue;
    }
    const records = await readGrokSqliteRecords(file);
    if (records.length === 0) continue;
    const grouped = new Map<string, Array<unknown>>();
    for (const record of records) {
      const externalSessionId =
        firstString(record, [
          "sessionId",
          "session_id",
          "conversationId",
          "conversation_id",
          "threadId",
          "thread_id",
        ]) ?? NodePath.basename(file);
      const group = grouped.get(externalSessionId) ?? [];
      group.push(record);
      grouped.set(externalSessionId, group);
    }
    for (const [externalSessionId, sessionRecords] of grouped) {
      const conversation = makeConversation({
        config: input,
        externalSessionId,
        records: sessionRecords,
        updatedAt: new Date(stats.mtimeMs).toISOString(),
        resumeCursor: { schemaVersion: 1, sessionId: externalSessionId },
        fallbackTitle: `${input.displayName} conversation`,
        warnings: recordWarnings(sessionRecords),
      });
      if (conversation !== undefined) conversations.push(conversation);
    }
  }
  return conversations;
}

export async function discoverProviderConversations(
  input: ProviderImportConfig,
): Promise<ReadonlyArray<ImportedConversation>> {
  if (input.provider === "grok") {
    const sqliteConversations = await discoverGrok(input);
    if (sqliteConversations.length > 0) return sqliteConversations;
  }
  return discoverJsonProvider(input);
}

export function stableHash(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

export function expandHomeForImport(value: string | undefined): string {
  return resolveHome(value);
}

export function providerConfigValue(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  return configString(config, key);
}

export function providerDriverName(provider: ThreadImportProvider): ProviderDriverKind {
  return ProviderDriverKind.make(provider);
}
