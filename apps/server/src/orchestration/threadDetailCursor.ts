import type { ThreadId } from "@t3tools/contracts";

/**
 * Opaque, exclusive cursor for windowed thread detail reads. Encodes the thread
 * id, the `projection_turns.row_id` lower boundary of an already-delivered
 * page, and that boundary turn's `requested_at`. Passing it back requests the
 * adjacent disjoint slice of strictly older turns. The row id bounds
 * turn-linked rows; the timestamp bounds straggler user messages, which carry
 * no turn linkage (their `turn_id` is always null and only anchored ones appear
 * in `pending_message_id`). The thread id is embedded so a cursor can never be
 * replayed against a different thread. Clients must treat the string as opaque.
 */
export interface ThreadDetailPageCursor {
  readonly threadId: ThreadId;
  readonly beforeRowId: number;
  readonly beforeRequestedAt: string;
}

export function encodeThreadDetailPageCursor(cursor: ThreadDetailPageCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.threadId, r: cursor.beforeRowId, a: cursor.beforeRequestedAt }),
  ).toString("base64url");
}

/**
 * Returns null for anything that is not a well-formed cursor. A reverted or
 * otherwise deleted boundary turn stays valid: the boundary is an exclusive
 * row-id marker, not a row reference.
 */
export function decodeThreadDetailPageCursor(encoded: string): ThreadDetailPageCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.t !== "string" || record.t.length === 0) {
    return null;
  }
  if (typeof record.r !== "number" || !Number.isInteger(record.r) || record.r < 0) {
    return null;
  }
  if (typeof record.a !== "string" || record.a.length === 0) {
    return null;
  }
  return { threadId: record.t as ThreadId, beforeRowId: record.r, beforeRequestedAt: record.a };
}
