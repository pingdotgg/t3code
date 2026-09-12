// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads usage records from OpenCode's on-disk message store.
 *
 * OpenCode keeps every session message as a row of the `message` table in
 * `<data dir>/opencode.db`, each row carrying its payload as a JSON document.
 * Unlike the other providers' append-only JSONL transcripts there is nothing to
 * resume or memoise: a cold read of a months-deep store is cheap, so each scan
 * opens the database read-only, folds the eligible rows through
 * `parseOpenCodeMessageData`, and closes it.
 *
 * The read is concurrent-safe with a running OpenCode: WAL mode lets read-only
 * connections proceed while OpenCode writes. The result distinguishes "no
 * store on this machine" (an ordinary state, like a missing transcript
 * directory) from "the store could not be read" (a failure the page should
 * surface) because the source status they produce differs.
 *
 * @module opencodeUsageStore
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import { parseOpenCodeMessageData, type UsageRecord } from "./usageTranscripts.ts";

export type OpenCodeStoreRead =
  | { readonly kind: "ok"; readonly records: readonly UsageRecord[] }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string };

/**
 * Rows parsed per page. `node:sqlite` is synchronous and `Effect.promise`
 * offloads nothing, so a single `.all()` over a years-deep store would block
 * the server's event loop for the whole parse. Paging bounds each blocking
 * slice while a macrotask yield between pages lets concurrent connections
 * through, which is the same interleaving the streaming JSONL reader gets
 * from its I/O awaits.
 */
const PAGE_SIZE = 1000;

/** Node filesystem and SQLite errors carry a stable `code`. */
function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/** Bounds an error for the wire: `UsageSource.message` is a short user-facing string. */
function failureMessage(error: unknown): string {
  const code = errorCode(error);
  const detail = error instanceof Error ? error.message : String(error);
  return `OpenCode store read failed${code ? ` (${code})` : ""}: ${detail.slice(0, 160)}`;
}

/** Yields to the macrotask queue so pending I/O and socket work can run. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Reads every assistant message row at or after `sinceMs`, oldest first.
 *
 * Pages walk `rowid`, which is the table's B-tree key, so each page is a
 * direct seek rather than a rescan; `time_created` carries no index and is
 * filtered per row. Insertion order is not chronological — a backfilled or
 * clock-adjusted message can hold a later `rowid` with an earlier
 * `time_created` — so the returned records are ordered by `time_created` with
 * `rowid` as the tie breaker. A row whose payload no longer parses (an older
 * or newer OpenCode writing an unexpected shape) is skipped individually,
 * mirroring how the JSONL parsers treat unrecognised lines, so one odd row
 * cannot blank out the provider.
 */
export async function readOpenCodeUsageRecords(
  dbPath: string,
  sinceMs: number,
): Promise<OpenCodeStoreRead> {
  try {
    await NodeFSP.stat(dbPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "failed", message: failureMessage(error) };
  }

  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    return { kind: "failed", message: failureMessage(error) };
  }

  try {
    const selectPage = database.prepare(
      "SELECT rowid, session_id, data, time_created FROM message WHERE rowid > ? ORDER BY rowid LIMIT ?",
    );
    const parsed: { readonly rowid: number; readonly record: UsageRecord }[] = [];
    let lastRowid = 0;
    for (;;) {
      const rows = selectPage.all(lastRowid, PAGE_SIZE) as unknown as readonly {
        rowid: number;
        session_id: unknown;
        data: unknown;
        time_created: unknown;
      }[];
      if (rows.length === 0) break;
      for (const row of rows) {
        lastRowid = row.rowid;
        if (typeof row.time_created !== "number" || row.time_created < sinceMs) continue;
        if (typeof row.data !== "string") continue;
        const record = parseOpenCodeMessageData(
          row.data,
          typeof row.session_id === "string" ? row.session_id : "",
        );
        if (record !== null) parsed.push({ rowid: row.rowid, record });
      }
      if (rows.length < PAGE_SIZE) break;
      await yieldToEventLoop();
    }
    const records = parsed
      .toSorted((a, b) => a.record.timestampMs - b.record.timestampMs || a.rowid - b.rowid)
      .map((entry) => entry.record);
    return { kind: "ok", records };
  } catch (error) {
    return { kind: "failed", message: failureMessage(error) };
  } finally {
    database.close();
  }
}
