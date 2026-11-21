/**
 * SQLite mailbox primitives for a single entity Durable Object. Every
 * operation returns an Effect whose body runs synchronously, so callers can
 * compose them and wrap the composition in a storage transaction.
 *
 * @internal
 */
import type { SqlStorage } from "@cloudflare/workers-types"
import * as Effect from "effect/Effect"

/** @internal */
export const mailboxCapacity = 4096

/** @internal */
export const maximumEncodedSize = 2 * 1024 * 1024

/** @internal */
export class MailboxFullError extends Error {
  readonly _tag = "MailboxFull"
}

/** @internal */
export class EncodedMessageTooLargeError extends Error {
  readonly _tag = "EncodedMessageTooLarge"
}

/** @internal */
export type PersistResult = {
  readonly _tag: "Success"
} | {
  readonly _tag: "Duplicate"
  readonly originalId: string
  readonly processed: boolean
}

type ExistingMessageRow = {
  readonly request_id: string
  readonly discard: number
  readonly processed: number
  readonly reply_to: string | null
}

type CountRow = {
  readonly count: number
}

const textEncoder = new TextEncoder()

// A UTF-16 code unit encodes to at most 3 UTF-8 bytes, so most strings skip
// the byte-length copy.
const exceedsMaximumEncodedSize = (text: string): boolean =>
  text.length * 3 > maximumEncodedSize && textEncoder.encode(text).byteLength > maximumEncodedSize

/** @internal */
export const persistRequest = (
  sql: SqlStorage,
  envelopeText: string,
  primaryKey: string | null,
  discard = false,
  deliverAt: number | null = null,
  replyTo: string | null = null
): Effect.Effect<PersistResult, MailboxFullError | EncodedMessageTooLargeError> =>
  Effect.suspend((): Effect.Effect<PersistResult, MailboxFullError | EncodedMessageTooLargeError> => {
    if (exceedsMaximumEncodedSize(envelopeText)) {
      return Effect.fail(new EncodedMessageTooLargeError("Encoded entity request exceeds 2 MB"))
    }
    const envelope = JSON.parse(envelopeText) as { readonly _tag?: unknown; readonly requestId?: unknown }
    if (envelope._tag !== "Request" || typeof envelope.requestId !== "string") {
      throw new TypeError("Expected an encoded Request envelope")
    }

    const existing = sql.exec<ExistingMessageRow>(
      `SELECT m.request_id, m.discard, m.processed, m.reply_to
       FROM cluster_messages m
       WHERE m.request_id = ? OR (? IS NOT NULL AND m.message_id = ?)
       LIMIT 1`,
      envelope.requestId,
      primaryKey,
      primaryKey
    ).toArray()[0]
    if (existing !== undefined) {
      if (replyTo !== null && existing.discard === 0 && existing.processed === 0) {
        const replyTos = decodeReplyTargets(existing.reply_to)
        const requestId = envelope.requestId
        if (!replyTos.some((target) => target.replyTo === replyTo && target.requestId === requestId)) {
          replyTos.push({ replyTo, requestId })
        }
        sql.exec(
          "UPDATE cluster_messages SET reply_to = ? WHERE request_id = ?",
          JSON.stringify(replyTos),
          existing.request_id
        )
      }
      return Effect.succeed<PersistResult>({
        _tag: "Duplicate",
        originalId: existing.request_id,
        processed: existing.processed === 1
      })
    }

    // A request counts against capacity until it is processed and, for streams,
    // until its chunks are acknowledged. Two indexed counts instead of one
    // `OR EXISTS` scan over the ever-growing dedup history.
    const pending = sql.exec<CountRow>(
      "SELECT COUNT(*) AS count FROM cluster_messages WHERE processed = 0"
    ).toArray()[0]?.count ?? 0
    const unacked = pending >= mailboxCapacity ?
      0 :
      sql.exec<CountRow>(
        `SELECT COUNT(DISTINCT r.request_id) AS count
         FROM cluster_replies r
         JOIN cluster_messages m ON m.request_id = r.request_id
         WHERE r.kind = 'Chunk' AND r.acked = 0 AND m.processed = 1`
      ).toArray()[0]?.count ?? 0
    if (pending + unacked >= mailboxCapacity) {
      return Effect.fail(new MailboxFullError("Entity mailbox has reached its 4096 request capacity"))
    }

    sql.exec(
      `INSERT INTO cluster_messages
         (request_id, message_id, envelope, discard, processed, last_reply_id, deliver_at, reply_to)
       VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
      envelope.requestId,
      primaryKey,
      envelopeText,
      discard ? 1 : 0,
      deliverAt,
      replyTo === null ? null : JSON.stringify([{ replyTo, requestId: envelope.requestId }])
    )
    return Effect.succeed<PersistResult>({ _tag: "Success" })
  })

/** @internal */
export const saveReply = (sql: SqlStorage, replyText: string): Effect.Effect<void, EncodedMessageTooLargeError> =>
  Effect.suspend(() => {
    if (exceedsMaximumEncodedSize(replyText)) {
      return Effect.fail(new EncodedMessageTooLargeError("Encoded entity reply chunk exceeds 2 MB"))
    }
    const reply = JSON.parse(replyText) as {
      readonly _tag?: unknown
      readonly requestId?: unknown
      readonly id?: unknown
      readonly sequence?: unknown
    }
    if (
      (reply._tag !== "Chunk" && reply._tag !== "WithExit") ||
      typeof reply.requestId !== "string" ||
      typeof reply.id !== "string"
    ) {
      throw new TypeError("Expected an encoded Chunk or WithExit reply")
    }
    sql.exec(
      `INSERT OR IGNORE INTO cluster_replies
         (reply_id, request_id, reply, kind, sequence, acked)
       VALUES (?, ?, ?, ?, ?, 0)`,
      reply.id,
      reply.requestId,
      replyText,
      reply._tag,
      reply._tag === "Chunk" ? reply.sequence : null
    )
    sql.exec(
      `UPDATE cluster_messages
       SET last_reply_id = ?, processed = CASE WHEN ? = 'WithExit' THEN 1 ELSE processed END
       WHERE request_id = ?`,
      reply.id,
      reply._tag,
      reply.requestId
    )
    return Effect.void
  })

/**
 * A pinned caller of a scheduled ask: the reply is pushed to the `replyTo`
 * entity under the caller's own request id, which it registered before
 * sending, so the push cannot arrive ahead of the registration.
 *
 * @internal
 */
export interface ReplyTarget {
  readonly replyTo: string
  readonly requestId: string
}

/** @internal */
export interface StoredMessage {
  readonly requestId: string
  readonly envelope: string
  readonly lastSentChunk: string | undefined
  readonly discard: boolean
  readonly deliverAt?: number | undefined
  readonly replyTos?: ReadonlyArray<ReplyTarget> | undefined
}

type StoredMessageRow = {
  readonly request_id: string
  readonly envelope: string
  readonly discard: number
  readonly deliver_at: number | null
  readonly reply_to: string | null
  readonly last_reply: string | null
}

const isReplyTarget = (item: unknown): item is ReplyTarget =>
  typeof item === "object" && item !== null &&
  typeof (item as ReplyTarget).replyTo === "string" &&
  typeof (item as ReplyTarget).requestId === "string"

const decodeReplyTargets = (value: unknown): Array<ReplyTarget> => {
  if (typeof value !== "string") return []
  try {
    const decoded = JSON.parse(value)
    if (Array.isArray(decoded) && decoded.every(isReplyTarget)) return decoded
  } catch {
    // Malformed rows deliver nowhere instead of poisoning the replay.
  }
  return []
}

const rowToMessage = (row: StoredMessageRow): StoredMessage => {
  const replyTos = decodeReplyTargets(row.reply_to)
  const message: StoredMessage = {
    requestId: row.request_id,
    envelope: row.envelope,
    lastSentChunk: row.last_reply ?? undefined,
    discard: row.discard === 1,
    ...(row.deliver_at === null ? undefined : { deliverAt: row.deliver_at }),
    ...(replyTos.length === 0 ? undefined : { replyTos })
  }
  return message
}

/** @internal */
export const loadUnprocessed = (sql: SqlStorage, now?: number): Effect.Effect<Array<StoredMessage>> =>
  Effect.sync(() =>
    sql.exec<StoredMessageRow>(
      `SELECT m.request_id, m.envelope, m.discard, m.deliver_at, m.reply_to, r.reply AS last_reply
       FROM cluster_messages m
       LEFT JOIN cluster_replies r ON r.reply_id = m.last_reply_id
       WHERE m.processed = 0 AND (m.deliver_at IS NULL OR m.deliver_at <= ?)
       ORDER BY m.rowid ASC`,
      now ?? Date.now()
    ).toArray().map(rowToMessage)
  )

/** @internal */
export const loadMessage = (sql: SqlStorage, requestId: string): Effect.Effect<StoredMessage | undefined> =>
  Effect.sync(() => {
    const row = sql.exec<StoredMessageRow>(
      `SELECT m.request_id, m.envelope, m.discard, m.deliver_at, m.reply_to, r.reply AS last_reply
       FROM cluster_messages m
       LEFT JOIN cluster_replies r ON r.reply_id = m.last_reply_id
       WHERE m.request_id = ?
       LIMIT 1`,
      requestId
    ).toArray()[0]
    return row === undefined ? undefined : rowToMessage(row)
  })

/** @internal */
export interface NextReply {
  readonly reply: string
  readonly kind: "Chunk" | "WithExit"
}

type NextReplyRow = {
  readonly reply: string
  readonly kind: NextReply["kind"]
}

/** @internal */
export const loadNextReply = (sql: SqlStorage, requestId: string): Effect.Effect<NextReply | undefined> =>
  Effect.sync(() => {
    const row = sql.exec<NextReplyRow>(
      `SELECT reply, kind
       FROM cluster_replies
       WHERE request_id = ? AND kind = 'Chunk' AND acked = 0
       ORDER BY sequence ASC
       LIMIT 1`,
      requestId
    ).toArray()[0] ?? sql.exec<NextReplyRow>(
      `SELECT reply, kind
       FROM cluster_replies
       WHERE request_id = ? AND kind = 'WithExit'
       LIMIT 1`,
      requestId
    ).toArray()[0]
    return row
  })

/** @internal */
export const completeTell = (sql: SqlStorage, requestId: string): Effect.Effect<void> =>
  Effect.sync(() => {
    sql.exec(
      `UPDATE cluster_messages
       SET processed = 1, last_reply_id = NULL
       WHERE request_id = ?`,
      requestId
    )
  })

/** @internal */
export const ackChunk = (sql: SqlStorage, requestId: string, replyId: string): Effect.Effect<void> =>
  Effect.sync(() => {
    sql.exec(
      `UPDATE cluster_replies
       SET acked = 1
       WHERE request_id = ? AND reply_id = ? AND kind = 'Chunk'`,
      requestId,
      replyId
    )
  })

/** @internal */
export const clearReplies = (sql: SqlStorage, requestId: string): Effect.Effect<void> =>
  Effect.sync(() => {
    sql.exec("DELETE FROM cluster_replies WHERE request_id = ?", requestId)
    sql.exec(
      `UPDATE cluster_messages
       SET processed = 0, last_reply_id = NULL
       WHERE request_id = ?`,
      requestId
    )
  })
