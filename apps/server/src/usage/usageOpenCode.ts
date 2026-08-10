// @effect-diagnostics nodeBuiltinImport:off
/**
 * OpenCode local usage — reads assistant message rows from `opencode*.db`.
 *
 * OpenCode records per-message `cost` and `tokens` in SQLite under its data
 * directory. Message-level totals are preferred over `part` `step-finish`
 * events so multi-step turns are not double-counted.
 *
 * @module usageOpenCode
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

export interface OpenCodeDbFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/** Resolves OpenCode's data directory the same way the CLI does. */
export function resolveOpenCodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = NodeOS.homedir(),
): string {
  const dataDir = env["OPENCODE_DATA_DIR"]?.trim();
  if (dataDir && dataDir.length > 0) return expandHome(dataDir, homeDir);

  const xdg = env["XDG_DATA_HOME"]?.trim();
  if (xdg && xdg.length > 0) return NodePath.join(expandHome(xdg, homeDir), "opencode");

  return NodePath.join(homeDir, ".local", "share", "opencode");
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return NodePath.join(homeDir, value.slice(2));
  return value;
}

/** Lists `opencode*.db` files (stable + preview channels) under the data dir. */
export async function listOpenCodeDatabases(dataDir: string): Promise<readonly OpenCodeDbFile[]> {
  let entries;
  try {
    entries = await NodeFSP.readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: OpenCodeDbFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("opencode") || !entry.name.endsWith(".db")) continue;
    // Skip sidecar files that somehow match; real DBs are `opencode.db`,
    // `opencode-next.db`, etc.
    if (entry.name.includes("-wal") || entry.name.includes("-shm")) continue;
    const child = NodePath.join(dataDir, entry.name);
    try {
      const stats = await NodeFSP.stat(child);
      // SQLite often appends to the WAL without touching the main file until a
      // checkpoint. Fold WAL size/mtime into the cache identity so new usage
      // invalidates the scan cache.
      let size = stats.size;
      let mtimeMs = stats.mtimeMs;
      try {
        const walStats = await NodeFSP.stat(`${child}-wal`);
        size += walStats.size;
        mtimeMs = Math.max(mtimeMs, walStats.mtimeMs);
      } catch {
        // No WAL (or unreadable) — main-file identity is enough.
      }
      found.push({ path: child, size, mtimeMs });
    } catch {
      // Vanished between readdir and stat.
    }
  }
  return found;
}

function intField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Maps one OpenCode assistant `message.data` JSON blob into a usage record.
 *
 * Pure — used by the SQLite scanner and by unit tests.
 */
export function parseOpenCodeMessageData(
  dataJson: string,
  messageId: string,
  sessionId: string,
): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const data = parsed as Record<string, unknown>;
  if (data["role"] !== "assistant") return null;

  const model =
    typeof data["modelID"] === "string"
      ? data["modelID"]
      : typeof data["model"] === "string"
        ? data["model"]
        : "";
  if (model.length === 0) return null;

  const time = data["time"];
  const created =
    typeof time === "object" && time !== null
      ? (time as Record<string, unknown>)["created"]
      : undefined;
  if (typeof created !== "number" || !Number.isFinite(created)) return null;
  const timestampMs = Math.trunc(created);

  const tokensRaw = data["tokens"];
  if (typeof tokensRaw !== "object" || tokensRaw === null) return null;
  const tokens = tokensRaw as Record<string, unknown>;
  const cacheRaw = tokens["cache"];
  const cache =
    typeof cacheRaw === "object" && cacheRaw !== null
      ? (cacheRaw as Record<string, unknown>)
      : {};

  const inputTokens = intField(tokens["input"]);
  const cacheRead = intField(cache["read"]);
  const cacheWrite = intField(cache["write"]);
  const outputOnly = intField(tokens["output"]);
  const reasoningTokens = intField(tokens["reasoning"]);
  // OpenCode's `reasoning` is disjoint from `output` (unlike Codex). Fold it
  // into the output bucket so `totalTokens` stays correct without double-count.
  const outputTokens = outputOnly + reasoningTokens;

  // OpenCode's `input` is uncached prompt tokens (cache read/write are separate).
  const totals: UsageTokenTotals = {
    uncachedInputTokens: inputTokens,
    cachedInputTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, reasoningTokens),
  };

  if (totalTokens(totals) === 0) return null;

  const cost = data["cost"];
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;

  return {
    provider: "opencode",
    timestampMs,
    model,
    sessionId,
    totals,
    reportedCostUsd,
    dedupeKey: messageId.length > 0 ? `opencode:${messageId}` : null,
  };
}

/**
 * Reads assistant usage from one OpenCode DB. Returns `null` when the file
 * cannot be opened (distinct from an empty result).
 */
export function readOpenCodeDatabaseRecords(dbPath: string): readonly UsageRecord[] | null {
  if (!NodeFS.existsSync(dbPath)) return null;

  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const rows = db
      .prepare(
        `SELECT id, session_id, data
         FROM message
         WHERE json_extract(data, '$.role') = 'assistant'`,
      )
      .all() as unknown as ReadonlyArray<{ id: unknown; session_id: unknown; data: unknown }>;

    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (typeof row.data !== "string") continue;
      const messageId = typeof row.id === "string" ? row.id : "";
      const sessionId = typeof row.session_id === "string" ? row.session_id : "";
      const record = parseOpenCodeMessageData(row.data, messageId, sessionId);
      if (record !== null) records.push(record);
    }
    return records;
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}
