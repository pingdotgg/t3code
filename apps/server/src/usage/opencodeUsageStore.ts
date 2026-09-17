// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads usage records out of OpenCode's local SQLite store.
 *
 * OpenCode keeps session history in `$XDG_DATA_HOME/opencode/opencode.db`
 * rather than JSONL transcripts. Assistant rows of the `message` table carry
 * per-message tokens and cost in their `data` JSON. Only `message` is read:
 * `session_message` is the v2 projection and is empty in the wild, and
 * OpenCode's own usage migration aggregates from `message` as well.
 *
 * The database is re-read wholesale whenever its `(size, mtime)` changes;
 * there is no append-only byte stream to resume from, and the `message` table
 * is small (one row per message), so a full scan is milliseconds. A `null`
 * result means "could not read" and, as with `readTranscriptRecords`, must not
 * be cached by the caller.
 *
 * `node:sqlite` is used directly rather than the Effect `SqliteClient` layer:
 * this seam is a plain per-scan probe like the transcript reader, not
 * application persistence.
 *
 * @module opencodeUsageStore
 */
import * as NodeSqlite from "node:sqlite";

import type { TranscriptParseResult } from "./usageTranscriptReader.ts";
import { parseOpenCodeMessage, type UsageRecord } from "./usageTranscripts.ts";

/** No byte position to resume from; decodeScanCache accepts the zero form. */
const NO_POSITION = { resumeOffset: 0, guardLength: 0, guardHash: 0, codexState: null } as const;

export async function readOpenCodeUsageRecords(
  dbPath: string,
): Promise<TranscriptParseResult | null> {
  let database: NodeSqlite.DatabaseSync;
  try {
    database = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
  try {
    // No SQL-side role filter: `json_extract` throws on malformed JSON and
    // would abort the scan; `parseOpenCodeMessage` gates safely instead.
    const rows = database.prepare("SELECT id, session_id, time_created, data FROM message").all();
    const records: UsageRecord[] = [];
    for (const row of rows) {
      const { id, session_id, time_created, data } = row;
      if (
        typeof id !== "string" ||
        typeof session_id !== "string" ||
        typeof time_created !== "number" ||
        typeof data !== "string"
      ) {
        continue;
      }
      const record = parseOpenCodeMessage({
        id,
        sessionId: session_id,
        timestampMs: time_created,
        data,
      });
      if (record !== null) records.push(record);
    }
    return { records, tailRecords: [], position: NO_POSITION, resumed: false };
  } catch {
    // No `message` table, or a schema we do not understand yet.
    return null;
  } finally {
    database.close();
  }
}
