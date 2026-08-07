import type { ThreadId } from "@t3tools/contracts";

/**
 * Opaque, exclusive cursor for windowed thread detail reads. Encodes the thread
 * id and the keyset boundary of an already-delivered page: the boundary turn's
 * anchor timestamp (`COALESCE(requested_at, started_at, '')`) and turn id.
 * Passing it back requests the adjacent disjoint slice of strictly older turns
 * under `(anchor, turn_id)` ordering.
 *
 * The boundary is deliberately NOT a `projection_turns.row_id`: row ids are
 * rewritten by the revert projector (delete + re-upsert) and by projection
 * rebuilds, which would silently invalidate every persisted cursor with no
 * event emitted. The (anchor, turnId) pair is derived from event content, so
 * cursors survive both and no client-side refresh machinery is needed. The
 * anchor doubles as the time bound for rows with no turn linkage (straggler
 * user messages, turnless activities). The thread id is embedded so a cursor
 * can never be replayed against a different thread. Clients must treat the
 * string as opaque.
 */
export interface ThreadDetailPageCursor {
  readonly threadId: ThreadId;
  readonly beforeAnchorAt: string;
  /** Boundary turn id; "" for the rare turn row with a null turn_id. */
  readonly beforeTurnId: string;
}

export function encodeThreadDetailPageCursor(cursor: ThreadDetailPageCursor): string {
  return Buffer.from(
    JSON.stringify({ t: cursor.threadId, a: cursor.beforeAnchorAt, i: cursor.beforeTurnId }),
  ).toString("base64url");
}

/**
 * Returns null for anything that is not a well-formed cursor. Callers degrade
 * a malformed or foreign-thread cursor to a first-page request.
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
  // Empty strings are valid boundary values, not malformed input: the anchor
  // is COALESCE(requested_at, started_at, ''), so a boundary turn with no
  // timestamps encodes a: "" (and sorts before every real anchor, correctly
  // ending the walk); the turn key is "" for a null turn_id.
  if (typeof record.a !== "string") {
    return null;
  }
  if (typeof record.i !== "string") {
    return null;
  }
  return { threadId: record.t as ThreadId, beforeAnchorAt: record.a, beforeTurnId: record.i };
}
