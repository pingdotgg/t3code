// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads usage from OpenCode's native data store.
 *
 * Current OpenCode releases persist messages in `opencode.db`. Older releases
 * used `storage/message/<session>/<message>.json`; that layout remains a
 * fallback only when the database is absent so migrated messages are never
 * counted twice.
 *
 * @module usageOpenCodeReader
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

export interface OpenCodeMessageRow {
  readonly id: unknown;
  readonly sessionId: unknown;
  readonly timeCreated: unknown;
  readonly data: unknown;
}

export interface OpenCodeUsageReadResult {
  readonly storageKind: "sqlite" | "json" | "missing";
  readonly records: readonly UsageRecord[];
  readonly scannedFiles: number;
  readonly skippedFiles: number;
  readonly malformedRecords: number;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function decodeMessageData(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return object(data);
  try {
    return object(JSON.parse(data));
  } catch {
    return null;
  }
}

/** Maps one OpenCode assistant message to the shared usage representation. */
export function parseOpenCodeMessageRow(row: OpenCodeMessageRow): UsageRecord | null {
  const message = decodeMessageData(row.data);
  if (message === null || message["role"] !== "assistant") return null;

  const model = typeof message["modelID"] === "string" ? message["modelID"].trim() : "";
  if (model.length === 0) return null;

  const tokens = object(message["tokens"]);
  if (tokens === null) return null;
  const cache = object(tokens["cache"]);
  const outputTokens = positiveInt(tokens["output"]);
  const totals = {
    // OpenCode stores uncached input and cache reads/writes as disjoint fields.
    uncachedInputTokens: positiveInt(tokens["input"]),
    cachedInputTokens: positiveInt(cache?.["read"]),
    cacheCreationTokens: positiveInt(cache?.["write"]),
    outputTokens,
    // Reasoning is included in output, matching the shared usage contract.
    reasoningTokens: Math.min(outputTokens, positiveInt(tokens["reasoning"])),
  };
  if (totalTokens(totals) === 0) return null;

  const time = object(message["time"]);
  const timestampMs = timestamp(time?.["completed"] ?? time?.["created"] ?? row.timeCreated);
  if (timestampMs === null) return null;

  const messageId =
    typeof message["id"] === "string" ? message["id"] : typeof row.id === "string" ? row.id : "";
  const sessionId =
    typeof message["sessionID"] === "string"
      ? message["sessionID"]
      : typeof row.sessionId === "string"
        ? row.sessionId
        : "";
  const cost = message["cost"];

  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId,
    totals,
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    dedupeKey: messageId.length > 0 ? `opencode:${messageId}` : null,
  };
}

/** OpenCode follows XDG_DATA_HOME and otherwise uses ~/.local/share/opencode. */
export function resolveOpenCodeDataDir(homePath: string, xdgDataHome: string | undefined): string {
  const dataHome = xdgDataHome?.trim();
  return dataHome
    ? NodePath.join(dataHome, "opencode")
    : NodePath.join(homePath, ".local", "share", "opencode");
}

function readSqliteUsage(databasePath: string, sinceMs: number): OpenCodeUsageReadResult | null {
  let database: NodeSqlite.DatabaseSync | undefined;
  try {
    database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true, timeout: 5_000 });
    const rows = database
      .prepare(
        `SELECT id, session_id AS sessionId, time_created AS timeCreated, data
         FROM message
         WHERE time_created >= ?
           AND json_valid(data) = 1
           AND json_extract(data, '$.role') = 'assistant'`,
      )
      .all(sinceMs) as unknown as OpenCodeMessageRow[];
    const records: UsageRecord[] = [];
    let malformedRecords = 0;
    for (const row of rows) {
      const record = parseOpenCodeMessageRow(row);
      if (record === null) malformedRecords += 1;
      else records.push(record);
    }
    return {
      storageKind: "sqlite",
      records,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords,
    };
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

async function listLegacyMessages(root: string, sinceMs: number): Promise<readonly string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      try {
        const stats = await NodeFSP.stat(child);
        if (stats.mtimeMs >= sinceMs) files.push(child);
      } catch {
        // The message rotated while the directory walk was in flight.
      }
    }
  };
  await walk(root);
  return files;
}

async function readLegacyUsage(
  messageRoot: string,
  sinceMs: number,
): Promise<OpenCodeUsageReadResult> {
  const files = await listLegacyMessages(messageRoot, sinceMs);
  const records: UsageRecord[] = [];
  let skippedFiles = 0;
  let malformedRecords = 0;

  for (const filePath of files) {
    try {
      const data = await NodeFSP.readFile(filePath, "utf8");
      const record = parseOpenCodeMessageRow({
        id: NodePath.basename(filePath, ".json"),
        sessionId: NodePath.basename(NodePath.dirname(filePath)),
        timeCreated: 0,
        data,
      });
      if (record === null) skippedFiles += 1;
      else records.push(record);
    } catch {
      malformedRecords += 1;
    }
  }

  return {
    storageKind: "json",
    records,
    scannedFiles: files.length,
    skippedFiles,
    malformedRecords,
  };
}

/** Reads OpenCode usage without opening auth/config files or message parts. */
export async function readOpenCodeUsage(
  dataDir: string,
  sinceMs: number,
): Promise<OpenCodeUsageReadResult | null> {
  const databasePath = NodePath.join(dataDir, "opencode.db");
  if (NodeFS.existsSync(databasePath)) return readSqliteUsage(databasePath, sinceMs);

  const messageRoot = NodePath.join(dataDir, "storage", "message");
  if (NodeFS.existsSync(messageRoot)) return readLegacyUsage(messageRoot, sinceMs);

  return {
    storageKind: "missing",
    records: [],
    scannedFiles: 0,
    skippedFiles: 0,
    malformedRecords: 0,
  };
}
