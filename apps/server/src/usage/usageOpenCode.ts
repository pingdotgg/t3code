// @effect-diagnostics nodeBuiltinImport:off
/**
 * OpenCode usage reader — scans the CLI's SQLite session databases.
 *
 * OpenCode persists assistant turns with token and cost fields in
 * `~/.local/share/opencode/opencode.db` (legacy `message` table) and
 * `opencode-next.db` (`session_message`). The two databases do not share
 * session ids on observed installs, so both are scanned. Raw rows never leave
 * this module; callers receive the same {@link UsageRecord} shape as the
 * JSONL transcript parsers.
 *
 * @module usageOpenCode
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";
import type { TranscriptFile } from "./usageTranscriptReader.ts";

const OPENCODE_DB_NAMES = ["opencode.db", "opencode-next.db"] as const;

/**
 * Resolves OpenCode's data directory (`opencode debug paths` → `data`).
 *
 * Honours `XDG_DATA_HOME` the same way the CLI does. There is no per-instance
 * home override in T3 settings today.
 */
export function resolveOpenCodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg && xdg.length > 0) {
    return NodePath.resolve(xdg, "opencode");
  }
  return NodePath.join(NodeOS.homedir(), ".local", "share", "opencode");
}

/**
 * Lists the known OpenCode SQLite databases under `dataDir`, if present.
 *
 * The returned fingerprint includes the WAL sidecar. OpenCode can append new
 * messages without changing the main database file until SQLite checkpoints,
 * so keying the scan cache from the main file alone would serve stale usage.
 */
export async function listOpenCodeDatabaseFiles(
  dataDir: string,
): Promise<readonly TranscriptFile[]> {
  const found: TranscriptFile[] = [];
  for (const name of OPENCODE_DB_NAMES) {
    const path = NodePath.join(dataDir, name);
    try {
      const stats = await NodeFSP.stat(path);
      if (stats.isFile()) {
        let size = stats.size;
        let mtimeMs = stats.mtimeMs;
        try {
          const walStats = await NodeFSP.stat(`${path}-wal`);
          if (walStats.isFile()) {
            size += walStats.size;
            mtimeMs = Math.max(mtimeMs, walStats.mtimeMs);
          }
        } catch {
          // A missing WAL means the database is fully checkpointed.
        }
        found.push({ path, size, mtimeMs });
      }
    } catch {
      // Missing DB is normal on a fresh install or mid-migration.
    }
  }
  return found;
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return asRecord(raw);
}

function resolveTimestampMs(
  data: Record<string, unknown>,
  columnTimeMs: number | null,
): number | null {
  const time = asRecord(data["time"]);
  const created = time?.["created"] ?? time?.["completed"];
  if (typeof created === "number" && Number.isFinite(created)) return Math.trunc(created);
  if (columnTimeMs !== null && Number.isFinite(columnTimeMs) && columnTimeMs > 0) {
    return Math.trunc(columnTimeMs);
  }
  return null;
}

function resolveModel(data: Record<string, unknown>): string | null {
  if (typeof data["modelID"] === "string" && data["modelID"].trim().length > 0) {
    return data["modelID"].trim();
  }
  const model = asRecord(data["model"]);
  if (typeof model?.["id"] === "string" && model["id"].trim().length > 0) {
    return model["id"].trim();
  }
  return null;
}

function resolveTotals(tokens: Record<string, unknown>): UsageTokenTotals | null {
  const cache = asRecord(tokens["cache"]) ?? {};
  const outputTokens = int(tokens["output"]);
  const totals: UsageTokenTotals = {
    // OpenCode's `input` is exclusive of cache read/write (Claude-shaped).
    uncachedInputTokens: int(tokens["input"]),
    cachedInputTokens: int(cache["read"]),
    cacheCreationTokens: int(cache["write"]),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, int(tokens["reasoning"])),
  };
  return totalTokens(totals) === 0 ? null : totals;
}

/**
 * Parses one OpenCode assistant payload into a usage record.
 *
 * Accepts both the legacy `message.data` shape (`modelID` / `role`) and the
 * next-schema `session_message.data` shape (`model.id`).
 */
export function parseOpenCodeAssistantData(
  raw: unknown,
  meta: {
    readonly messageId: string;
    readonly sessionId: string;
    readonly columnTimeMs: number | null;
  },
): UsageRecord | null {
  const data = parseJsonObject(raw);
  if (data === null) return null;

  // Legacy rows are role-tagged; next-schema rows are filtered by SQL type.
  if (data["role"] !== undefined && data["role"] !== "assistant") return null;

  const tokens = asRecord(data["tokens"]);
  if (tokens === null) return null;
  const totals = resolveTotals(tokens);
  if (totals === null) return null;

  const model = resolveModel(data);
  if (model === null) return null;

  const timestampMs = resolveTimestampMs(data, meta.columnTimeMs);
  if (timestampMs === null) return null;

  const cost = data["cost"];
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;

  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId: meta.sessionId,
    totals,
    reportedCostUsd,
    dedupeKey: meta.messageId.length > 0 ? `opencode:${meta.messageId}` : null,
  };
}

interface MessageRow {
  readonly id: string;
  readonly session_id: string;
  readonly time_created: number | null;
  readonly data: unknown;
}

function tableExists(database: NodeSqlite.DatabaseSync, name: string): boolean {
  const row = database
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name) as { ok: number } | undefined;
  return row !== undefined;
}

/**
 * Reads usage records from one OpenCode database file.
 *
 * Returns `null` when the file cannot be opened so the caller's scan cache
 * does not memoize a transient failure under the current `(size, mtime)`.
 */
export async function readOpenCodeDatabaseRecords(
  dbPath: string,
  sinceMs: number,
): Promise<readonly UsageRecord[] | null> {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const records: UsageRecord[] = [];

    if (tableExists(database, "message")) {
      const rows = database
        .prepare(
          `SELECT id, session_id, time_created, data
           FROM message
           WHERE time_created >= ?`,
        )
        .all(sinceMs) as unknown as MessageRow[];
      for (const row of rows) {
        const record = parseOpenCodeAssistantData(row.data, {
          messageId: row.id,
          sessionId: row.session_id,
          columnTimeMs: row.time_created,
        });
        if (record !== null) records.push(record);
      }
    }

    if (tableExists(database, "session_message")) {
      const rows = database
        .prepare(
          `SELECT id, session_id, time_created, data
           FROM session_message
           WHERE type = 'assistant' AND time_created >= ?`,
        )
        .all(sinceMs) as unknown as MessageRow[];
      for (const row of rows) {
        const record = parseOpenCodeAssistantData(row.data, {
          messageId: row.id,
          sessionId: row.session_id,
          columnTimeMs: row.time_created,
        });
        if (record !== null) records.push(record);
      }
    }

    return records;
  } catch {
    return null;
  } finally {
    try {
      database.close();
    } catch {
      // Best-effort close.
    }
  }
}
