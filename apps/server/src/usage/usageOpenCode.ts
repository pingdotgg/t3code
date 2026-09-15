// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw SQLite access for the OpenCode usage scan.
 *
 * Reads bounded rowid batches and yields between them so a large history
 * does not monopolize the server thread. The completion timestamp lives in
 * JSON; filtering on the indexed creation time would lose older messages
 * completed inside the requested window. Handles stay read-only and do not
 * wait on database locks on the server thread.
 *
 * Every assistant row counts, whichever upstream provider opencode routed it
 * to; see `parseOpenCodeRow`.
 *
 * @module usageOpenCode
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeTimersPromises from "node:timers/promises";

import { parseOpenCodeRow, type UsageRecord } from "./usageTranscripts.ts";

export const OPENCODE_DB_FILENAME = "opencode.db";

export type OpenCodeReadResult =
  | {
      readonly ok: true;
      readonly records: readonly UsageRecord[];
      readonly malformedRecords: number;
      /** A table that exists could not be read, so its rows are missing. */
      readonly partial: boolean;
    }
  | { readonly ok: false };

const READ_BATCH_SIZE = 256;

const TABLES = [
  { table: "session_message", assistant: "type = 'assistant'" },
  { table: "message", assistant: "json_extract(data, '$.role') = 'assistant'" },
] as const;

/**
 * Reads Go usage messages newer than `windowStartMs` from both message tables
 * opencode keeps, `session_message` and the older `message`. One message id
 * can appear in both, so the caller's dedupe pass collapses the copies.
 */
export async function readOpenCodeRecords(
  dbPath: string,
  windowStartMs: number,
): Promise<OpenCodeReadResult> {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return { ok: false };
  }
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // Either table can stand alone, so only a table that exists but cannot be
    // read counts against the scan.
    const present = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
        .all(...TABLES.map(({ table }) => table))
        .map((row) => row.name),
    );
    const records: UsageRecord[] = [];
    let malformedRecords = 0;
    let readableTables = 0;
    let partial = false;
    for (const { table, assistant } of TABLES) {
      if (!present.has(table)) continue;
      const start = records.length;
      const malformedStart = malformedRecords;
      try {
        // All interpolated identifiers come from TABLES, never user input.
        const last = db.prepare(`SELECT max(rowid) AS rowid FROM ${table}`).get()?.rowid;
        if (last === null) {
          readableTables += 1;
          continue;
        }
        if (typeof last !== "number") throw new Error("Invalid OpenCode rowid");
        const read = db.prepare(`SELECT rowid, id, session_id AS sessionId,
          CASE WHEN json_valid(data) THEN
            CASE WHEN ${assistant}
              AND coalesce(json_extract(data, '$.time.completed'),
                json_extract(data, '$.time.created')) >= ?
            THEN data END
          END AS data
          FROM ${table} WHERE rowid > ? AND rowid <= ?
          ORDER BY rowid LIMIT ${READ_BATCH_SIZE}`);
        let cursor = 0;
        while (cursor < last) {
          const rows = read.all(windowStartMs, cursor, last);
          if (rows.length === 0) break;
          for (const row of rows) {
            if (typeof row.rowid !== "number") throw new Error("Invalid OpenCode rowid");
            cursor = row.rowid;
            if (row.data === null) continue;
            if (typeof row.id !== "string" || typeof row.sessionId !== "string") {
              malformedRecords += 1;
              continue;
            }
            const record = parseOpenCodeRow({
              id: row.id,
              sessionId: row.sessionId,
              data: row.data,
            });
            if (record === null) malformedRecords += 1;
            else records.push(record);
          }
          await NodeTimersPromises.setImmediate();
        }
        readableTables += 1;
      } catch {
        // Do not publish a partially read table.
        records.length = start;
        malformedRecords = malformedStart;
        partial = true;
      }
    }
    return readableTables > 0 ? { ok: true, records, malformedRecords, partial } : { ok: false };
  } catch {
    return { ok: false };
  } finally {
    try {
      db.close();
    } catch {
      // Closing a read-only handle cannot lose usage.
    }
  }
}
