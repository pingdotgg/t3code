/**
 * Persists cluster mailbox messages and replies in SQL.
 *
 * The SQL-backed `MessageStorage` stores encoded cluster envelopes and reply
 * chunks so runners can recover mailbox state after restarts. It supports
 * redelivering unprocessed messages, deduplicating requests by primary key, and
 * replaying reply chunks until they are acknowledged. This module includes the
 * storage constructor, layers, migrations, optional table prefixes, and the row
 * mapping needed by encoded message storage.
 *
 * `layer`, `layerWith`, `make`, and `makeEncoded` run the migrations before
 * building the storage. To run migrations with a different connection, such as
 * a schema owner in a deploy step, use `layerMigrations` there and
 * `layerStorage` or `makeEncodedStorage` in the runtime.
 *
 * Request deduplication keys that exceed the 255-character `message_id`
 * column are hashed with the `Digest.Digest` service before they are written, so
 * composed keys of any length are supported; shorter keys are stored as
 * plaintext, byte-compatible with rows written by previous versions.
 *
 * On MySQL, `deleteProcessed` needs MySQL 8.0.1+ or MariaDB 10.6+ for
 * `SKIP LOCKED`. It runs at READ COMMITTED, which needs `binlog_format` `ROW`
 * or `MIXED`. Inside a caller's transaction it keeps that transaction's
 * isolation level, which must also be READ COMMITTED on MySQL before 8.0.20
 * and on MariaDB, or it can deadlock with a concurrent reply.
 *
 * @stability unstable
 * @since 4.0.0
 */
// eslint-disable effect/no-bigint-literals
import * as Arr from "../Array.ts"
import * as Digest from "../crypto/Digest.ts"
import * as Effect from "../Effect.ts"
import { identity } from "../Function.ts"
import * as Layer from "../Layer.ts"
import * as Option from "../Option.ts"
import * as Migrator from "../sql/Migrator.ts"
import * as SqlClient from "../sql/SqlClient.ts"
import type { Row } from "../sql/SqlConnection.ts"
import { isSqlError, SqlError, UnknownError } from "../sql/SqlError.ts"
import type { Fragment } from "../sql/Statement.ts"
import { PersistenceError } from "./ClusterError.ts"
import type * as EntityAddress from "./EntityAddress.ts"
import type * as Envelope from "./Envelope.ts"
import * as MachineId from "./MachineId.ts"
import * as MessageStorage from "./MessageStorage.ts"
import { SaveResultEncoded } from "./MessageStorage.ts"
import type * as Reply from "./Reply.ts"
import * as ShardId from "./ShardId.ts"
import type { ShardingConfig } from "./ShardingConfig.ts"
import * as Snowflake from "./Snowflake.ts"

const withTracerDisabled = Effect.withTracerEnabled(false)

/**
 * Creates a SQL-backed encoded message storage driver, running its migrations
 * and using the optional table prefix.
 *
 * **When to use**
 *
 * Use when you need the SQL-backed encoded driver directly, such as when
 * composing a custom message storage adapter.
 *
 * **Details**
 *
 * The optional `prefix` controls the table names for messages, replies, and
 * migrations; when omitted, `cluster` is used.
 *
 * **Gotchas**
 *
 * Changing `prefix` after deployment points the runtime at a different set of
 * tables, including the migration history table.
 *
 * @see {@link make} for the decoded `MessageStorage` constructor
 * @see {@link makeEncodedStorage} for construction without migrations
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const makeEncoded: (options?: {
  readonly prefix?: string | undefined
}) => Effect.Effect<
  MessageStorage.Encoded,
  never,
  SqlClient.SqlClient | Digest.Digest
> = (options) => Effect.andThen(runMessageMigrations(options), makeEncodedStorage(options))

/**
 * Creates a SQL-backed encoded message storage driver without running migrations
 * or executing startup SQL.
 *
 * **When to use**
 *
 * Use when composing a custom encoded adapter with a runtime SQL connection
 * that does not have schema-management privileges.
 *
 * **Details**
 *
 * The optional `prefix` controls the message and reply table names; when omitted,
 * `cluster` is used.
 *
 * **Gotchas**
 *
 * Run `layerMigrations` separately with the same prefix before using the driver.
 * This constructor does not create tables or check that the schema is up to date.
 *
 * @see {@link makeEncoded} for construction that runs migrations
 * @see {@link layerMigrations} for running migrations separately
 * @see {@link layerStorage} for providing decoded storage without migrations
 *
 * @stability unstable
 * @category constructors
 * @since 4.1.0
 */
export const makeEncodedStorage: (options?: {
  readonly prefix?: string | undefined
}) => Effect.Effect<
  MessageStorage.Encoded,
  never,
  SqlClient.SqlClient | Digest.Digest
> = Effect.fnUntraced(function*(
  options?: {
    readonly prefix?: string | undefined
  }
) {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms()
  const digest = yield* Digest.Digest
  const prefix = options?.prefix ?? "cluster"
  const table = (name: string) => `${prefix}_${name}`

  const messageKindRequest = sql.literal(String(messageKind.Request))
  const messageKindAckChunk = sql.literal(String(messageKind.AckChunk))
  const messageKindInterrupt = sql.literal(String(messageKind.Interrupt))
  const replyKindWithExit = sql.literal(String(replyKind.WithExit))

  const messagesTable = table("messages")
  const messagesTableSql = sql(messagesTable)

  const repliesTable = table("replies")
  const repliesTableSql = sql(repliesTable)

  // The composed primary key (`entityType/entityId/tag/id`) can legally exceed
  // the 255-character `message_id` column: entity_type(150) + entity_id(255) +
  // tag(50) alone total 458 characters before the RPC primary key is appended.
  // Keys that fit are stored as-is, keeping `message_id` byte-compatible with
  // rows written by previous versions; longer keys are stored as a SHA-256
  // digest (64 hex characters, collision probability negligible at a 2^128
  // birthday bound). Digests never contain "/" while composed keys always do,
  // so the two encodings cannot collide.
  const encoder = new TextEncoder()
  const messageIdForPrimaryKey = (primaryKey: string): Effect.Effect<string> =>
    primaryKey.length <= 255
      ? Effect.succeed(primaryKey)
      : digest.digestHex(Digest.sha256, encoder.encode(primaryKey))

  const messageIdEnforcesWidth = sql.onDialectOrElse({
    mssql: () => true,
    mysql: () => true,
    pg: () => true,
    orElse: () => false
  })
  // sqlite's TEXT message_id column stored over-length plaintext keys before
  // digests were introduced; those legacy rows need a plaintext fallback read
  const mayHaveLegacyRow = (primaryKey: string): boolean => !messageIdEnforcesWidth && primaryKey.length > 255

  const envelopeToRow = (
    envelope: Envelope.Encoded,
    message_id: string | null,
    deliver_at: number | null
  ): MessageRow => {
    switch (envelope._tag) {
      case "Request":
        return {
          id: envelope.requestId,
          message_id,
          shard_id: ShardId.toString(envelope.address.shardId),
          entity_type: envelope.address.entityType,
          entity_id: envelope.address.entityId,
          kind: messageKind.Request,
          tag: envelope.tag,
          payload: JSON.stringify(envelope.payload),
          headers: JSON.stringify(envelope.headers),
          trace_id: envelope.traceId ?? null,
          span_id: envelope.spanId ?? null,
          sampled: envelope.sampled === undefined
            ? null
            : supportsBooleans
            ? envelope.sampled
            : envelope.sampled
            ? 1
            : 0,
          request_id: envelope.requestId,
          reply_id: null,
          deliver_at
        }
      case "AckChunk":
        return {
          id: envelope.id,
          message_id,
          shard_id: ShardId.toString(envelope.address.shardId),
          entity_type: envelope.address.entityType,
          entity_id: envelope.address.entityId,
          kind: messageKind.AckChunk,
          tag: null,
          payload: null,
          headers: null,
          trace_id: null,
          span_id: null,
          sampled: null,
          request_id: envelope.requestId,
          reply_id: envelope.replyId,
          deliver_at
        }
      case "Interrupt":
        return {
          id: envelope.id,
          message_id,
          shard_id: ShardId.toString(envelope.address.shardId),
          entity_type: envelope.address.entityType,
          entity_id: envelope.address.entityId,
          kind: messageKind.Interrupt,
          payload: null,
          tag: null,
          headers: null,
          trace_id: null,
          span_id: null,
          sampled: null,
          request_id: envelope.requestId,
          reply_id: null,
          deliver_at
        }
    }
  }

  const replyToRow = (reply: Reply.Encoded): ReplyRow => ({
    id: reply.id,
    kind: replyKind[reply._tag],
    request_id: reply.requestId,
    payload: reply._tag === "WithExit" ? JSON.stringify(reply.exit) : JSON.stringify(reply.values),
    sequence: reply._tag === "Chunk" ? reply.sequence : null
  })

  const supportsBooleans = sql.onDialectOrElse({
    mssql: () => false,
    sqlite: () => false,
    orElse: () => true
  })

  const messageFromRow = (row: MessageRow & ReplyJoinRow): {
    readonly envelope: Envelope.Encoded
    readonly lastSentReply: Option.Option<Reply.Encoded>
  } => {
    switch (Number(row.kind) as 0 | 1 | 2) {
      case 0:
        return {
          envelope: {
            _tag: "Request",
            requestId: String(row.id),
            address: {
              shardId: ShardId.fromStringEncoded(row.shard_id),
              entityType: row.entity_type,
              entityId: row.entity_id
            },
            tag: row.tag!,
            payload: JSON.parse(row.payload!),
            headers: JSON.parse(row.headers!),
            ...(row.trace_id ?
              ({
                traceId: row.trace_id,
                spanId: row.span_id!,
                sampled: !!row.sampled
              }) :
              undefined)
          },
          lastSentReply: row.reply_reply_id ?
            Option.some({
              _tag: "Chunk",
              id: String(row.reply_reply_id),
              requestId: String(row.request_id),
              sequence: Number(row.reply_sequence!),
              values: JSON.parse(row.reply_payload!)
            }) :
            Option.none()
        }
      case 1:
        return {
          envelope: {
            _tag: "AckChunk",
            id: String(row.id),
            requestId: String(row.request_id!),
            replyId: String(row.reply_id!),
            address: {
              shardId: ShardId.fromStringEncoded(row.shard_id),
              entityType: row.entity_type,
              entityId: row.entity_id
            }
          },
          lastSentReply: Option.none()
        }
      case 2:
        return {
          envelope: {
            _tag: "Interrupt",
            id: String(row.id),
            requestId: String(row.request_id!),
            address: {
              shardId: ShardId.fromStringEncoded(row.shard_id),
              entityType: row.entity_type,
              entityId: row.entity_id
            }
          },
          lastSentReply: Option.none()
        }
    }
  }

  const sqlFalse = sql.literal(supportsBooleans ? "FALSE" : "0")
  const sqlTrue = sql.literal(supportsBooleans ? "TRUE" : "1")

  // Read SQLite IDs as text to avoid rounding on number-returning drivers
  // such as Durable Objects.
  const idsAsText = sql.onDialectOrElse({
    sqlite: () => true,
    orElse: () => false
  })
  const idAs = (column: string, alias: string) =>
    idsAsText ? `CAST(${column} AS TEXT) AS ${alias}` : `${column} AS ${alias}`
  const replyJoinColumns = "r.kind as reply_kind, r.payload as reply_payload, r.sequence as reply_sequence"
  const messageColumns = idsAsText
    ? `${idAs("m.id", "id")}, m.message_id, m.shard_id, m.entity_type, m.entity_id, m.kind, m.tag, m.payload, ` +
      `m.headers, m.trace_id, m.span_id, m.sampled, m.processed, ${idAs("m.request_id", "request_id")}, ` +
      `${idAs("m.reply_id", "reply_id")}, ${idAs("m.last_reply_id", "last_reply_id")}, m.last_read, m.deliver_at`
    : "m.*"

  const idColumn = sql.literal(idAs("id", "id"))
  const replyColumns = sql.literal(
    `${idAs("id", "id")}, kind, ${idAs("request_id", "request_id")}, payload, sequence`
  )
  const duplicateColumns = sql.literal(
    `${idAs("m.id", "id")}, ${idAs("r.id", "reply_id")}, ${replyJoinColumns}`
  )
  const messageJoinColumns = sql.literal(
    `${messageColumns}, ${idAs("r.id", "reply_reply_id")}, ${replyJoinColumns}`
  )

  const selectByMessageId = (message_id: string): Effect.Effect<ReadonlyArray<Row>, SqlError> =>
    sql`
      SELECT ${duplicateColumns}
      FROM ${messagesTableSql} m
      LEFT JOIN ${repliesTableSql} r ON r.id = m.last_reply_id
      WHERE m.message_id = ${message_id}
    `
  const maxInsertAttempts = 3
  // Runs an insert that reports whether it stored the row, returning the
  // existing row with the same message_id when it did not
  const insertUnlessExists = (
    insert: (row: MessageRow, message_id: string) => Effect.Effect<boolean, SqlError>
  ) =>
  (row: MessageRow, message_id: string): Effect.Effect<ReadonlyArray<Row>, SqlError> => {
    // deleteProcessed can delete the existing row before it is read, so insert
    // again rather than report a save that stored nothing
    const loop = (attempt: number): Effect.Effect<ReadonlyArray<Row>, SqlError> =>
      Effect.flatMap(
        insert(row, message_id),
        (inserted) =>
          inserted ? Effect.succeed([]) : Effect.flatMap(selectByMessageId(message_id), (rows) => {
            if (rows.length > 0) return Effect.succeed(rows)
            if (attempt < maxInsertAttempts) return loop(attempt + 1)
            return Effect.fail(
              new SqlError({
                reason: new UnknownError({
                  cause: undefined,
                  message: `Message ${message_id} conflicted with a row that was deleted before it could be read`,
                  operation: "saveEnvelope"
                })
              })
            )
          })
      )
    return loop(1)
  }

  const insertEnvelope: (
    row: MessageRow,
    message_id: string
  ) => Effect.Effect<ReadonlyArray<Row>, SqlError> = sql.onDialectOrElse({
    pg: () =>
      insertUnlessExists((row) =>
        Effect.map(
          sql`
            INSERT INTO ${messagesTableSql} ${sql.insert(row)}
            ON CONFLICT (message_id) DO NOTHING
            RETURNING id
          `,
          (rows) => rows.length > 0
        )
      ),
    mysql: () =>
      insertUnlessExists((row) =>
        Effect.map(
          sql`INSERT IGNORE INTO ${messagesTableSql} ${sql.insert(row)}`.raw,
          (result: any) => result.affectedRows > 0
        )
      ),
    mssql: () =>
      insertUnlessExists((row, message_id) =>
        Effect.map(
          sql`
            MERGE ${messagesTableSql} WITH (HOLDLOCK) AS target
            USING (SELECT ${message_id} as message_id) AS source
            ON target.message_id = source.message_id
            WHEN NOT MATCHED THEN
              INSERT ${sql.insert(row)}
            OUTPUT inserted.id;
          `,
          (rows) => rows.length > 0
        )
      ),
    // SQLite has a single writer, so no delete can run between read and insert
    orElse: () => (row, message_id) =>
      selectByMessageId(message_id).pipe(
        Effect.tap(sql`INSERT OR IGNORE INTO ${messagesTableSql} ${sql.insert(row)}`),
        sql.withTransaction,
        Effect.retry({ times: 3 })
      )
  })

  const tenMinutesAgo = sql.onDialectOrElse({
    mssql: () => sql.literal(`DATEADD(MINUTE, -10, GETDATE())`),
    mysql: () => sql.literal(`NOW() - INTERVAL 10 MINUTE`),
    pg: () => sql.literal(`NOW() - INTERVAL '10 minutes'`),
    orElse: () => sql.literal(`DATETIME('now', '-10 minute')`)
  })
  const sqlNowString = sql.onDialectOrElse({
    pg: () => "NOW()",
    mysql: () => "NOW()",
    mssql: () => "GETDATE()",
    orElse: () => "CURRENT_TIMESTAMP"
  })
  const sqlNow = sql.literal(sqlNowString)

  const wrapString = sql.onDialectOrElse({
    mssql: () => (s: string) => `N'${s}'`,
    orElse: () => (s: string) => `'${s}'`
  })
  const forUpdate = sql.onDialectOrElse({
    mssql: () => sql.literal(""),
    sqlite: () => sql.literal(""),
    orElse: () => sql.literal("FOR UPDATE")
  })
  // mssql locks claimed rows with a table hint instead of FOR UPDATE
  const updateLock = sql.onDialectOrElse({
    mssql: () => sql.literal("WITH (UPDLOCK)"),
    orElse: () => sql.literal("")
  })
  // Like updateLock and forUpdate, but skips locked rows. REPEATABLEREAD keeps
  // mssql's READPAST valid at any session isolation level.
  const skipLockedHint = sql.onDialectOrElse({
    mssql: () => sql.literal("WITH (UPDLOCK, READPAST, REPEATABLEREAD)"),
    orElse: () => sql.literal("")
  })
  const forUpdateSkipLocked = sql.onDialectOrElse({
    mssql: () => sql.literal(""),
    sqlite: () => sql.literal(""),
    orElse: () => sql.literal("FOR UPDATE SKIP LOCKED")
  })
  // Writes to a request's replies lock its row first, in deleteProcessed's
  // order, so they cannot deadlock. An empty result means it was deleted, or
  // does not match the filter.
  const lockRequest = (requestId: string, filter: Fragment = emptyFragment) =>
    sql`SELECT 1 FROM ${messagesTableSql} ${updateLock} WHERE id = ${requestId} ${filter} ${forUpdate}`
  // mssql can scan the clustered index on small tables and deadlock on other
  // requests' rows, so these statements force the request_id indexes
  const markAcksProcessed: (requestId: string) => Effect.Effect<unknown, SqlError> = sql.onDialectOrElse({
    mssql: () => (requestId) =>
      sql`
        UPDATE m SET processed = ${sqlTrue}
        FROM ${messagesTableSql} m WITH (INDEX(${sql(messagesTable + "_request_id_idx")}))
        WHERE m.processed = ${sqlFalse} AND m.request_id = ${requestId} AND m.kind = ${messageKindAckChunk}
      `,
    orElse: () => (requestId) =>
      sql`
        UPDATE ${messagesTableSql} SET processed = ${sqlTrue}
        WHERE processed = ${sqlFalse} AND request_id = ${requestId} AND kind = ${messageKindAckChunk}
      `
  })
  const deleteRequests: (ids: Fragment) => Effect.Effect<unknown, SqlError> = sql.onDialectOrElse({
    mssql: () => (ids) =>
      Effect.andThen(
        sql`
          DELETE r FROM ${repliesTableSql} r WITH (INDEX(${sql(repliesTable + "_request_lookup_idx")}))
          WHERE r.request_id IN (${ids})
        `,
        sql`
          DELETE m FROM ${messagesTableSql} m WITH (INDEX(${sql(messagesTable + "_request_id_idx")}))
          WHERE m.request_id IN (${ids})
        `
      ),
    // A scanning DELETE locks every row it reads and can deadlock. MySQL
    // ignores FORCE INDEX here, so an optimizer hint keeps it on the index.
    // Servers without hints (before 8.0.20, MariaDB) rely on cleanupIsolation.
    mysql: () => (ids) =>
      Effect.andThen(
        sql`
          DELETE /*+ INDEX(${repliesTableSql} ${sql(repliesTable + "_request_lookup_idx")}) */
          FROM ${repliesTableSql} WHERE request_id IN (${ids})
        `,
        sql`
          DELETE /*+ INDEX(${messagesTableSql} ${sql(messagesTable + "_request_id_idx")}) */
          FROM ${messagesTableSql} WHERE request_id IN (${ids})
        `
      ),
    orElse: () => (ids) =>
      Effect.andThen(
        sql`DELETE FROM ${repliesTableSql} WHERE request_id IN (${ids})`,
        sql`DELETE FROM ${messagesTableSql} WHERE request_id IN (${ids})`
      )
  })
  // Gap locks at MySQL's default REPEATABLE READ let a scanning DELETE
  // deadlock with saveReply. READ COMMITTED takes none, but the server rejects
  // it with binlog_format STATEMENT. A caller's transaction keeps its level.
  const cleanupIsolation: <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> = sql
    .onDialectOrElse({
      mysql: () => Effect.provideService(SqlClient.BeginTransaction, "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"),
      orElse: () => identity
    })
  // Locks up to limit eligible requests, skipping locked ones, since waiting
  // can deadlock on MySQL gap locks. Ordering by last_reply_id keeps the
  // query on the retention index.
  const lockDeletable: (
    eligible: Fragment,
    limit: number
  ) => Effect.Effect<ReadonlyArray<{ id: string | bigint }>, SqlError> = sql.onDialectOrElse({
    // A MySQL locking scan also locks ineligible rows, in the opposite order
    // to lockRequest, so find candidates unlocked, then lock them by id and
    // recheck them
    mysql: () => (eligible, limit) =>
      Effect.flatMap(
        sql<{ id: string | bigint }>`
          SELECT id FROM ${messagesTableSql} WHERE ${eligible} ORDER BY last_reply_id ASC ${limitFragment(limit)}
        `,
        (candidates) =>
          candidates.length === 0 ? Effect.succeed(candidates) : sql<{ id: string | bigint }>`
            SELECT id FROM ${messagesTableSql} FORCE INDEX (id)
            WHERE id IN (${sql.literal(candidates.map((row) => String(row.id)).join(","))}) AND ${eligible}
            FOR UPDATE SKIP LOCKED
          `
      ),
    orElse: () => (eligible, limit) =>
      sql<{ id: string | bigint }>`
        SELECT ${idColumn} FROM ${messagesTableSql} ${skipLockedHint}
        WHERE ${eligible}
        ORDER BY last_reply_id ASC
        ${limitFragment(limit)}
        ${forUpdateSkipLocked}
      `
  })

  const emptyFragment = sql.literal("")
  // mssql only limits with OFFSET/FETCH, which requires the ORDER BY that
  // both queries already have
  const limitFragment = sql.onDialectOrElse({
    mssql: () => (limit: number) => sql.literal(`OFFSET 0 ROWS FETCH NEXT ${Math.floor(limit)} ROWS ONLY`),
    orElse: () => (limit: number) => sql.literal(`LIMIT ${Math.floor(limit)}`)
  })
  const groupAddresses = (addresses: ReadonlyArray<EntityAddress.EntityAddress>) => {
    const byShard = new Map<string, Map<string, Array<EntityAddress.EntityAddress>>>()
    for (const address of addresses) {
      const shardId = address.shardId.toString()
      let byEntityType = byShard.get(shardId)
      if (byEntityType === undefined) {
        byShard.set(shardId, byEntityType = new Map())
      }
      const group = byEntityType.get(address.entityType)
      if (group === undefined) {
        byEntityType.set(address.entityType, [address])
      } else {
        group.push(address)
      }
    }
    return Array.from(
      byShard,
      ([shardId, byEntityType]) =>
        Array.from(byEntityType, ([entityType, addresses]) => ({ shardId, entityType, addresses }))
    ).flat()
  }
  type UnprocessedOptions = {
    readonly limit?: number | undefined
    readonly addresses?: ReadonlyArray<EntityAddress.EntityAddress> | undefined
  }
  const unprocessedFilters = (options?: UnprocessedOptions | undefined) => ({
    addressFilter: options?.addresses !== undefined
      ? sql`AND (${
        sql.or(
          groupAddresses(options.addresses).map((group) =>
            sql.and([
              sql`m.shard_id = ${group.shardId}`,
              sql`m.entity_type = ${group.entityType}`,
              sql.in("m.entity_id", group.addresses.map((address) => address.entityId))
            ])
          )
        )
      })`
      : emptyFragment,
    limit: options?.limit !== undefined ? limitFragment(options.limit) : emptyFragment
  })
  type UnprocessedFilters = ReturnType<typeof unprocessedFilters>

  const getUnprocessedMessagesForDialect = sql.onDialectOrElse({
    pg: () => (shardIds: ReadonlyArray<string>, now: number, filters: UnprocessedFilters) =>
      sql<MessageJoinRow>`
        WITH messages AS (
          UPDATE ${messagesTableSql} m
          SET last_read = ${sqlNow}
          FROM (
            SELECT m.*
            FROM ${messagesTableSql} m
            WHERE m.shard_id IN (${sql.literal(shardIds.map(wrapString).join(","))})
            ${filters.addressFilter}
            AND NOT EXISTS (
              SELECT 1 FROM ${repliesTableSql}
              WHERE request_id = m.request_id
              AND (kind = ${replyKindWithExit} OR acked = ${sqlFalse})
            )
            AND m.processed = ${sqlFalse}
            AND (m.last_read IS NULL OR m.last_read < ${tenMinutesAgo})
            AND (m.deliver_at IS NULL OR m.deliver_at <= ${sql.literal(String(now))})
            ORDER BY m.rowid ASC
            ${filters.limit}
            FOR UPDATE
          ) AS ids
          LEFT JOIN ${repliesTableSql} r ON r.id = ids.last_reply_id
          WHERE m.id = ids.id
          RETURNING ids.*, r.id as reply_reply_id, r.kind as reply_kind, r.payload as reply_payload, r.sequence as reply_sequence
        )
        SELECT * FROM messages ORDER BY rowid ASC
      `,
    orElse: () => (shardIds: ReadonlyArray<string>, now: number, filters: UnprocessedFilters) =>
      sql<MessageJoinRow>`
        SELECT ${messageJoinColumns}
        FROM ${messagesTableSql} m ${updateLock}
        LEFT JOIN ${repliesTableSql} r ON r.id = m.last_reply_id
        WHERE m.shard_id IN (${sql.literal(shardIds.map(wrapString).join(","))})
        ${filters.addressFilter}
        AND NOT EXISTS (
          SELECT 1 FROM ${repliesTableSql}
          WHERE request_id = m.request_id
          AND (kind = ${replyKindWithExit} OR acked = ${sqlFalse})
        )
        AND processed = ${sqlFalse}
        AND (m.last_read IS NULL OR m.last_read < ${tenMinutesAgo})
        AND (m.deliver_at IS NULL OR m.deliver_at <= ${sql.literal(String(now))})
        ORDER BY m.rowid ASC
        ${filters.limit}
        ${forUpdate}
      `.unprepared.pipe(
        Effect.tap((rows) => {
          if (rows.length === 0) {
            return Effect.void
          }
          return sql`
            UPDATE ${messagesTableSql}
            SET last_read = ${sqlNow}
            WHERE id IN (${sql.literal(rows.map((row) => row.id).join(","))})
          `.unprepared
        }),
        sql.withTransaction
      )
  })
  const getUnprocessedMessages = (
    shardIds: ReadonlyArray<string>,
    now: number,
    options?: UnprocessedOptions | undefined
  ) =>
    options?.addresses?.length === 0
      ? Effect.succeed([])
      : getUnprocessedMessagesForDialect(shardIds, now, unprocessedFilters(options))

  const resetUnprocessed = sql.onDialectOrElse({
    // Match the claim query's lock order to avoid deadlocks during resets.
    pg: () => (filter: Fragment) =>
      sql`
      WITH messages AS (
        SELECT id FROM ${messagesTableSql}
        WHERE processed = ${sqlFalse} AND ${filter}
        ORDER BY rowid ASC
        FOR UPDATE
      )
      UPDATE ${messagesTableSql}
      SET last_read = NULL
      WHERE id IN (SELECT id FROM messages)
    `,
    orElse: () => (filter: Fragment) =>
      sql`
      UPDATE ${messagesTableSql}
      SET last_read = NULL
      WHERE processed = ${sqlFalse} AND ${filter}
    `
  })

  const encoded: MessageStorage.Encoded = {
    saveEnvelope: ({ deliverAt, envelope, primaryKey }) =>
      Effect.suspend(() => {
        let insert: Effect.Effect<ReadonlyArray<Row>, SqlError>
        if (primaryKey !== null) {
          insert = Effect.flatMap(messageIdForPrimaryKey(primaryKey), (messageId) => {
            const row = envelopeToRow(envelope, messageId, deliverAt)
            if (!mayHaveLegacyRow(primaryKey)) {
              return insertEnvelope(row, messageId)
            }
            return Effect.flatMap(
              selectByMessageId(primaryKey),
              (rows) => rows.length > 0 ? Effect.succeed(rows) : insertEnvelope(row, messageId)
            )
          })
        } else {
          const row = envelopeToRow(envelope, null, deliverAt)
          const insertRow = Effect.as(sql`INSERT INTO ${messagesTableSql} ${sql.insert(row)}`.unprepared, [])
          insert = envelope._tag === "Request" ? insertRow : lockRequest(envelope.requestId).pipe(
            Effect.flatMap((request) =>
              // the request was deleted, so there is nothing left to acknowledge or interrupt
              request.length === 0 ?
                Effect.succeed([]) :
                envelope._tag === "Interrupt" ?
                insertRow :
                sql`UPDATE ${repliesTableSql} SET acked = ${sqlTrue} WHERE id = ${envelope.replyId}`.pipe(
                  Effect.andThen(markAcksProcessed(envelope.requestId)),
                  Effect.andThen(insertRow)
                )
            ),
            sql.withTransaction
          )
        }
        return insert.pipe(
          Effect.map((rows) => {
            if (rows.length === 0) {
              return SaveResultEncoded.Success()
            }
            const row = rows[0]
            const replyKindNum = typeof row.reply_kind === "bigint" ? Number(row.reply_kind) : row.reply_kind
            const lastReceivedReply: Option.Option<Reply.Encoded> = row.reply_id
              ? Option.some(
                replyKindNum === replyKind.WithExit
                  ? {
                    id: String(row.reply_id),
                    requestId: String(row.id),
                    _tag: "WithExit",
                    exit: JSON.parse(row.reply_payload as string)
                  }
                  : {
                    id: String(row.reply_id),
                    requestId: String(row.id),
                    _tag: "Chunk",
                    sequence: Number(row.reply_sequence),
                    values: JSON.parse(row.reply_payload as string)
                  }
              )
              : Option.none()
            return SaveResultEncoded.Duplicate({
              originalId: Snowflake.Snowflake(row.id as any),
              lastReceivedReply
            })
          })
        )
      }).pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
        PersistenceError.refail,
        withTracerDisabled
      ),

    saveReply: (reply) =>
      Effect.suspend(() => {
        const row = replyToRow(reply)
        const update = reply._tag === "Chunk" ?
          sql`UPDATE ${messagesTableSql} SET last_reply_id = ${reply.id} WHERE id = ${reply.requestId}` :
          sql`UPDATE ${messagesTableSql} SET processed = ${sqlTrue}, last_reply_id = ${reply.id} WHERE request_id = ${reply.requestId}`
        return update.unprepared.pipe(
          Effect.andThen(sql`INSERT INTO ${repliesTableSql} ${sql.insert(row)}`),
          sql.withTransaction
        )
      }).pipe(
        Effect.asVoid,
        PersistenceError.refail,
        withTracerDisabled
      ),

    clearReplies: Effect.fnUntraced(
      function*(requestId, options) {
        const id = String(requestId)
        const expectedReplyId = options?.expectedReplyId
        // A guarded reset only touches rows stamped by the expected reply, so
        // interrupts received after it are kept.
        const stamped = expectedReplyId === undefined
          ? emptyFragment
          : sql`AND last_reply_id = ${String(expectedReplyId)}`
        // Lock and check the current reply before mutating any of the request family.
        const current = yield* lockRequest(id, stamped)
        if (expectedReplyId !== undefined && current.length === 0) return
        yield* sql`DELETE FROM ${repliesTableSql} WHERE request_id = ${id} AND kind = 0`
        yield* sql`DELETE FROM ${messagesTableSql} WHERE request_id = ${id} AND kind = ${messageKindInterrupt} ${stamped}`
        yield* sql`UPDATE ${messagesTableSql} SET processed = ${sqlFalse}, last_reply_id = NULL, last_read = NULL
          WHERE request_id = ${id} ${stamped}`
      },
      sql.withTransaction,
      PersistenceError.refail,
      withTracerDisabled
    ),

    requestIdForPrimaryKey: (primaryKey) =>
      messageIdForPrimaryKey(primaryKey).pipe(
        Effect.flatMap((messageId) =>
          sql<{ id: string | bigint }>`SELECT ${idColumn} FROM ${messagesTableSql} WHERE message_id = ${messageId}`
        ),
        Effect.flatMap((rows) =>
          rows.length === 0 && mayHaveLegacyRow(primaryKey)
            ? sql<{ id: string | bigint }>`SELECT ${idColumn} FROM ${messagesTableSql} WHERE message_id = ${primaryKey}`
            : Effect.succeed(rows)
        ),
        Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]?.id), Snowflake.Snowflake)),
        Effect.provideService(SqlClient.SafeIntegers, true),
        PersistenceError.refail,
        withTracerDisabled
      ),

    repliesFor: (requestIds) =>
      // replies where:
      // - the request is in the list
      // - the kind is WithExit
      // - or the kind is Chunk and has not been acked yet
      sql<ReplyRow>`
        SELECT ${replyColumns}
        FROM ${repliesTableSql}
        WHERE request_id IN (${sql.literal(requestIds.join(","))})
        AND (
          kind = ${replyKindWithExit}
          OR (
            kind IS NULL
            AND acked = ${sqlFalse}
          )
        )
        ORDER BY rowid ASC
      `.unprepared.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
        Effect.map(Arr.map(replyFromRow)),
        PersistenceError.refail,
        withTracerDisabled
      ),

    repliesForUnfiltered: (requestIds) =>
      sql<ReplyRow>`
        SELECT ${replyColumns}
        FROM ${repliesTableSql}
        WHERE request_id IN (${sql.literal(requestIds.join(","))})
        ORDER BY rowid ASC
      `.unprepared.pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
        Effect.map(Arr.map(replyFromRow)),
        PersistenceError.refail,
        withTracerDisabled
      ),

    unprocessedMessages: Effect.fnUntraced(
      function*(shardIds, now, options) {
        const rows = yield* getUnprocessedMessages(shardIds, now, options)
        if (rows.length === 0) {
          return []
        }
        const messages: Array<{
          readonly envelope: Envelope.Encoded
          readonly lastSentReply: Option.Option<Reply.Encoded>
        }> = new Array(rows.length)
        const ids = new Array<string>(rows.length)
        for (let i = 0; i < rows.length; i++) {
          messages[i] = messageFromRow(rows[i])
          ids[i] = String(rows[i].id)
        }
        return messages
      },
      Effect.provideService(SqlClient.SafeIntegers, true),
      PersistenceError.refail,
      withTracerDisabled
    ),

    unprocessedMessagesById(ids, now) {
      const idArr = Array.from(ids, (id) => String(id))
      return sql<MessageRow & ReplyJoinRow>`
        SELECT ${messageJoinColumns}
        FROM ${messagesTableSql} m
        LEFT JOIN ${repliesTableSql} r ON r.id = m.last_reply_id
        WHERE m.id IN (${sql.literal(idArr.join(","))})
        AND NOT EXISTS (
          SELECT 1 FROM ${repliesTableSql}
          WHERE request_id = m.request_id
          AND (kind = ${replyKindWithExit} OR acked = ${sqlFalse})
        )
        AND m.processed = ${sqlFalse}
        AND (m.deliver_at IS NULL OR m.deliver_at <= ${sql.literal(String(now))})
        ORDER BY m.rowid ASC
      `.unprepared.pipe(
        Effect.map(Arr.map(messageFromRow)),
        Effect.provideService(SqlClient.SafeIntegers, true),
        PersistenceError.refail,
        withTracerDisabled
      )
    },

    resetRequests: (requestIds) =>
      requestIds.length === 0
        ? Effect.void
        : sql`
        UPDATE ${messagesTableSql}
        SET last_read = NULL
        WHERE processed = ${sqlFalse}
        AND ${sql.in("id", requestIds.map(String))}
        `.pipe(
          Effect.asVoid,
          PersistenceError.refail,
          withTracerDisabled
        ),

    resetAddresses: (addresses) =>
      addresses.length === 0
        ? Effect.void
        : resetUnprocessed(sql`(${
          sql.or(
            groupAddresses(addresses).map(
              (group) =>
                sql.and([
                  sql`shard_id = ${group.shardId}`,
                  sql`entity_type = ${group.entityType}`,
                  sql.in("entity_id", group.addresses.map((address) => address.entityId))
                ])
            )
          )
        })`).pipe(
          Effect.asVoid,
          PersistenceError.refail,
          withTracerDisabled
        ),

    clearAddress: (address) =>
      sql`
        DELETE FROM ${repliesTableSql}
        WHERE request_id IN (
          SELECT id FROM ${messagesTableSql}
          WHERE entity_type = ${address.entityType}
          AND entity_id = ${address.entityId}
        )
      `.pipe(
        Effect.andThen(
          sql`
            DELETE FROM ${messagesTableSql}
            WHERE entity_type = ${address.entityType}
            AND entity_id = ${address.entityId}
          `
        ),
        sql.withTransaction,
        Effect.asVoid,
        PersistenceError.refail,
        withTracerDisabled
      ),

    deleteProcessed: Effect.fnUntraced(
      function*({ completedBefore, entityType, limit }) {
        // No signed snowflake id is at or before this. Also covers -Infinity and NaN.
        if (!(completedBefore > Snowflake.constEpochMillis - 2 ** 41)) return 0
        // Reply timestamps are whole milliseconds, so round up. Every signed
        // snowflake id is below the cap, which also covers Infinity.
        const cutoff = Snowflake.make({
          timestamp: Math.min(Math.ceil(completedBefore), Snowflake.constEpochMillis + 2 ** 41),
          machineId: MachineId.make(0),
          sequence: 0
        })
        // Locked so a concurrent clearReplies cannot reset them first
        const rows = yield* lockDeletable(
          sql`
            entity_type = ${entityType}
            AND kind = ${messageKindRequest}
            AND processed = ${sqlTrue}
            AND last_reply_id < ${sql.literal(String(cutoff))}
          `,
          limit
        )
        if (rows.length === 0) return 0
        const ids = sql.literal(rows.map((row) => String(row.id)).join(","))
        yield* deleteRequests(ids)
        return rows.length
      },
      sql.withTransaction,
      cleanupIsolation,
      Effect.provideService(SqlClient.SafeIntegers, true),
      PersistenceError.refail,
      withTracerDisabled
    ),

    resetShards: (shardIds) =>
      resetUnprocessed(sql`shard_id IN (${sql.literal(shardIds.map(wrapString).join(","))})`).pipe(
        Effect.asVoid,
        PersistenceError.refail,
        withTracerDisabled
      ),

    withTransaction: (effect) =>
      sql.withTransaction(effect).pipe(
        Effect.catchIf(isSqlError, Effect.die)
      )
  }
  return encoded
}, withTracerDisabled)

/**
 * Creates a SQL-backed `MessageStorage` implementation, running its migrations
 * and using the optional table prefix.
 *
 * @stability unstable
 * @category constructors
 * @since 4.0.0
 */
export const make: (options?: {
  readonly prefix?: string | undefined
}) => Effect.Effect<
  MessageStorage.MessageStorage["Service"],
  never,
  SqlClient.SqlClient | Snowflake.Generator | Digest.Digest
> = (options) => Effect.flatMap(makeEncoded(options), MessageStorage.makeEncoded)

/**
 * Migration loader for the SQL message storage tables.
 *
 * **Details**
 *
 * History is recorded in `<prefix>_migrations`; the default
 * prefix is `cluster`.
 *
 * @stability unstable
 * @category migrations
 * @since 4.1.0
 */
export const migrations = (options?: {
  readonly prefix?: string | undefined
}): Migrator.Loader => {
  const prefix = options?.prefix ?? "cluster"
  const table = (name: string) => `${prefix}_${name}`
  const messagesTable = table("messages")
  const repliesTable = table("replies")

  // The migrator serializes PostgreSQL DDL. Propagate errors: retrying in an
  // aborted transaction cannot succeed.
  return Migrator.fromRecord({
    "0001_create_tables": Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const messagesTableSql = sql(messagesTable)
      const repliesTableSql = sql(repliesTable)

      // mssql UNIQUE constraints treat NULLs as equal, so nullable keys use
      // filtered unique indexes instead
      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`
            IF OBJECT_ID(N'${messagesTableSql}', N'U') IS NULL
            CREATE TABLE ${messagesTableSql} (
              id BIGINT PRIMARY KEY,
              rowid BIGINT IDENTITY(1,1),
              message_id VARCHAR(255),
              shard_id VARCHAR(50) NOT NULL,
              entity_type VARCHAR(150) NOT NULL,
              entity_id VARCHAR(255) NOT NULL,
              kind INT NOT NULL,
              tag VARCHAR(50),
              payload NVARCHAR(MAX),
              headers NVARCHAR(MAX),
              trace_id VARCHAR(32),
              span_id VARCHAR(16),
              sampled BIT,
              processed BIT NOT NULL DEFAULT 0,
              request_id BIGINT NOT NULL,
              reply_id BIGINT,
              last_reply_id BIGINT,
              last_read DATETIME,
              deliver_at BIGINT,
              INDEX ${sql(messagesTable + "_message_id_idx")} UNIQUE (message_id) WHERE message_id IS NOT NULL
            )
          `,
        mysql: () =>
          sql`
            CREATE TABLE IF NOT EXISTS ${messagesTableSql} (
              id BIGINT NOT NULL,
              rowid BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
              message_id VARCHAR(255),
              shard_id VARCHAR(50) NOT NULL,
              entity_type VARCHAR(150) NOT NULL,
              entity_id VARCHAR(255) NOT NULL,
              kind INT NOT NULL,
              tag VARCHAR(50),
              payload TEXT,
              headers TEXT,
              trace_id VARCHAR(32),
              span_id VARCHAR(16),
              sampled BOOLEAN,
              processed BOOLEAN NOT NULL DEFAULT FALSE,
              request_id BIGINT NOT NULL,
              reply_id BIGINT,
              last_reply_id BIGINT,
              last_read DATETIME,
              deliver_at BIGINT,
              UNIQUE (id),
              UNIQUE (message_id)
            )
          `,
        pg: () =>
          sql`
            CREATE TABLE IF NOT EXISTS ${messagesTableSql} (
              id BIGINT PRIMARY KEY,
              rowid BIGSERIAL,
              message_id VARCHAR(255),
              shard_id VARCHAR(50) NOT NULL,
              entity_type VARCHAR(150) NOT NULL,
              entity_id VARCHAR(255) NOT NULL,
              kind INT NOT NULL,
              tag VARCHAR(50),
              payload TEXT,
              headers TEXT,
              trace_id VARCHAR(32),
              span_id VARCHAR(16),
              sampled BOOLEAN,
              processed BOOLEAN NOT NULL DEFAULT FALSE,
              request_id BIGINT NOT NULL,
              reply_id BIGINT,
              last_reply_id BIGINT,
              last_read TIMESTAMP,
              deliver_at BIGINT,
              UNIQUE (message_id)
            )
          `,
        orElse: () =>
          // sqlite
          sql`
            CREATE TABLE IF NOT EXISTS ${messagesTableSql} (
              id INTEGER PRIMARY KEY,
              message_id TEXT,
              shard_id TEXT NOT NULL,
              entity_type TEXT NOT NULL,
              entity_id TEXT NOT NULL,
              kind INTEGER NOT NULL,
              tag TEXT,
              payload TEXT,
              headers TEXT,
              trace_id TEXT,
              span_id TEXT,
              sampled BOOLEAN,
              processed BOOLEAN NOT NULL DEFAULT FALSE,
              request_id INTEGER NOT NULL,
              reply_id INTEGER,
              last_reply_id INTEGER,
              last_read TEXT,
              deliver_at INTEGER,
              UNIQUE (message_id)
            )
          `
      })

      // Add message indexes optimized for the specific query patterns
      const shardLookupIndex = `${messagesTable}_shard_idx`
      const requestIdLookupIndex = `${messagesTable}_request_id_idx`
      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`
            IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = ${shardLookupIndex} AND object_id = OBJECT_ID(${messagesTable}))
            CREATE INDEX ${sql(shardLookupIndex)} 
            ON ${messagesTableSql} (shard_id, processed, last_read, deliver_at);

            IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = ${requestIdLookupIndex} AND object_id = OBJECT_ID(${messagesTable}))
            CREATE INDEX ${sql(requestIdLookupIndex)}
            ON ${messagesTableSql} (request_id);
          `,
        mysql: () =>
          sql`
            CREATE INDEX ${sql(shardLookupIndex)}
            ON ${messagesTableSql} (shard_id, processed, last_read, deliver_at);

            CREATE INDEX ${sql(requestIdLookupIndex)}
            ON ${messagesTableSql} (request_id);
          `.unprepared.pipe(Effect.ignore),
        pg: Effect.fnUntraced(function*() {
          yield* sql`
              CREATE INDEX IF NOT EXISTS ${sql(shardLookupIndex)}
              ON ${messagesTableSql} (shard_id, processed, last_read, deliver_at)
            `
          yield* sql`
              CREATE INDEX IF NOT EXISTS ${sql(requestIdLookupIndex)}
              ON ${messagesTableSql} (request_id)
            `
        }),
        orElse: () =>
          // sqlite
          Effect.all([
            sql`
              CREATE INDEX IF NOT EXISTS ${sql(shardLookupIndex)}
              ON ${messagesTableSql} (shard_id, processed, last_read, deliver_at)
            `,
            sql`
              CREATE INDEX IF NOT EXISTS ${sql(requestIdLookupIndex)}
              ON ${messagesTableSql} (request_id)
            `
          ]).pipe(sql.withTransaction)
      })

      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`
            IF OBJECT_ID(N'${repliesTableSql}', N'U') IS NULL
            CREATE TABLE ${repliesTableSql} (
              id BIGINT PRIMARY KEY,
              rowid BIGINT IDENTITY(1,1),
              kind INT,
              request_id BIGINT NOT NULL,
              payload NVARCHAR(MAX) NOT NULL,
              sequence INT,
              acked BIT NOT NULL DEFAULT 0,
              INDEX ${sql(repliesTable + "_one_exit")} UNIQUE (request_id, kind) WHERE kind IS NOT NULL,
              INDEX ${sql(repliesTable + "_sequence")} UNIQUE (request_id, sequence) WHERE sequence IS NOT NULL
            )
          `,
        mysql: () =>
          sql`
            CREATE TABLE IF NOT EXISTS ${repliesTableSql} (
              id BIGINT NOT NULL,
              rowid BIGINT AUTO_INCREMENT PRIMARY KEY,
              kind INT,
              request_id BIGINT NOT NULL,
              payload TEXT NOT NULL,
              sequence INT,
              acked BOOLEAN NOT NULL DEFAULT FALSE,
              UNIQUE (id),
              UNIQUE (request_id, kind),
              UNIQUE (request_id, sequence)
            )
          `,
        pg: () =>
          sql`
            CREATE TABLE IF NOT EXISTS ${repliesTableSql} (
              id BIGINT PRIMARY KEY,
              rowid BIGSERIAL,
              kind INT,
              request_id BIGINT NOT NULL,
              payload TEXT NOT NULL,
              sequence INT,
              acked BOOLEAN NOT NULL DEFAULT FALSE,
              UNIQUE (request_id, kind),
              UNIQUE (request_id, sequence)
            )
          `,
        orElse: () =>
          // sqlite
          sql`
            CREATE TABLE IF NOT EXISTS ${repliesTableSql} (
              id INTEGER PRIMARY KEY,
              kind INTEGER,
              request_id INTEGER NOT NULL,
              payload TEXT NOT NULL,
              sequence INTEGER,
              acked BOOLEAN NOT NULL DEFAULT FALSE,
              UNIQUE (request_id, kind),
              UNIQUE (request_id, sequence)
            )
          `
      })

      // Add reply indexes optimized for request_id lookups
      const replyLookupIndex = `${repliesTable}_request_lookup_idx`
      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`
            IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = ${replyLookupIndex} AND object_id = OBJECT_ID(${repliesTable}))
            CREATE INDEX ${sql(replyLookupIndex)}
            ON ${repliesTableSql} (request_id, kind, acked);
          `,
        mysql: () =>
          sql`
            CREATE INDEX ${sql(replyLookupIndex)}
            ON ${repliesTableSql} (request_id, kind, acked);
          `.unprepared.pipe(Effect.ignore),
        pg: () =>
          sql`
            CREATE INDEX IF NOT EXISTS ${sql(replyLookupIndex)}
            ON ${repliesTableSql} (request_id, kind, acked);
          `,
        orElse: () =>
          // sqlite
          sql`
            CREATE INDEX IF NOT EXISTS ${sql(replyLookupIndex)}
            ON ${repliesTableSql} (request_id, kind, acked);
          `
      })
    }),
    "0002_entity_type_size": Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const messagesTableSql = sql(messagesTable)

      // resize entity_type to 150 characters
      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`
            ALTER TABLE ${messagesTableSql} ALTER COLUMN entity_type VARCHAR(150) NOT NULL;
          `,
        mysql: () =>
          sql`
            ALTER TABLE ${messagesTableSql} MODIFY entity_type VARCHAR(150) NOT NULL;
          `.unprepared.pipe(Effect.ignore),
        pg: () =>
          sql`
            ALTER TABLE ${messagesTableSql} ALTER COLUMN entity_type TYPE VARCHAR(150);
          `,
        orElse: () =>
          // sqlite
          Effect.void
      })
    }),
    "0003_pg_messages_rowid_index": Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const messagesTableSql = sql(messagesTable)
      const rowIdIndex = `${messagesTable}_rowid_idx`

      yield* sql.onDialectOrElse({
        pg: () =>
          sql`
            CREATE INDEX IF NOT EXISTS ${sql(rowIdIndex)}
            ON ${messagesTableSql} (rowid)
          `,
        orElse: () => Effect.void
      })
    }),

    // 0001 looked mssql indexes up by name alone, so a same-named index on
    // another table skipped them. Writes force them, so create any missing.
    "0004_mssql_lookup_indexes": Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const ensureIndex = (index: string, table: string, columns: string) =>
        sql`
          IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = ${index} AND object_id = OBJECT_ID(${table}))
          CREATE INDEX ${sql(index)} ON ${sql(table)} (${sql.literal(columns)})
        `
      yield* sql.onDialectOrElse({
        mssql: () =>
          Effect.all([
            ensureIndex(`${messagesTable}_shard_idx`, messagesTable, "shard_id, processed, last_read, deliver_at"),
            ensureIndex(`${messagesTable}_request_id_idx`, messagesTable, "request_id"),
            ensureIndex(`${repliesTable}_request_lookup_idx`, repliesTable, "request_id, kind, acked")
          ], { discard: true }),
        orElse: () => Effect.void
      })
    }),

    // Serves deleteProcessed's lookup by entity type and final reply id
    "0005_retention_index": Effect.gen(function*() {
      const sql = (yield* SqlClient.SqlClient).withoutTransforms()
      const messagesTableSql = sql(messagesTable)
      const retentionIndex = `${messagesTable}_retention_idx`
      const columns = sql.literal("entity_type, processed, last_reply_id")
      yield* sql.onDialectOrElse({
        mssql: () =>
          sql`
            IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = ${retentionIndex} AND object_id = OBJECT_ID(${messagesTable}))
            CREATE INDEX ${sql(retentionIndex)} ON ${messagesTableSql} (${columns})
          `,
        mysql: () =>
          sql`
            SELECT 1 FROM information_schema.statistics
            WHERE table_schema = DATABASE() AND table_name = ${messagesTable} AND index_name = ${retentionIndex}
          `.pipe(
            Effect.flatMap((rows) =>
              rows.length > 0
                ? Effect.void
                : sql`CREATE INDEX ${sql(retentionIndex)} ON ${messagesTableSql} (${columns})`.unprepared
            )
          ),
        orElse: () => sql`CREATE INDEX IF NOT EXISTS ${sql(retentionIndex)} ON ${messagesTableSql} (${columns})`
      })
    })
  })
}

const runMessageMigrations = (options?: {
  readonly prefix?: string | undefined
}): Effect.Effect<void, never, SqlClient.SqlClient> =>
  Migrator.make({})({
    loader: migrations(options),
    table: `${options?.prefix ?? "cluster"}_migrations`
  }).pipe(Effect.asVoid, Effect.orDie)

/**
 * Runs the SQL message storage migrations without providing storage.
 *
 * **Details**
 *
 * Use an owner connection in a deploy step, then use `layerStorage` with a
 * DML-only runtime connection. History is recorded in `<prefix>_migrations`.
 * Migration errors become defects.
 *
 * On PostgreSQL, use the role's `search_path` to select a schema. A
 * schema-qualified prefix such as `app.cluster` produces an invalid index name.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.0
 */
export const layerMigrations = (options: {
  readonly prefix?: string | undefined
}): Layer.Layer<never, never, SqlClient.SqlClient> => Layer.effectDiscard(runMessageMigrations(options))

/**
 * Provides SQL-backed `MessageStorage` without DDL or startup schema checks.
 *
 * **Details**
 *
 * Run `layerMigrations` separately before using this layer.
 * This layer supplies `Snowflake.layerGenerator` internally.
 *
 * @stability unstable
 * @category layers
 * @since 4.1.0
 */
export const layerStorage = (options: {
  readonly prefix?: string | undefined
}): Layer.Layer<MessageStorage.MessageStorage, never, SqlClient.SqlClient | ShardingConfig | Digest.Digest> =>
  Layer.effect(
    MessageStorage.MessageStorage,
    Effect.flatMap(makeEncodedStorage(options), MessageStorage.makeEncoded)
  ).pipe(
    Layer.provide(Snowflake.layerGenerator)
  )

/**
 * Provides SQL-backed `MessageStorage` with a custom table prefix,
 * running migrations first.
 *
 * **Details**
 *
 * Migration errors become defects. Use `layerMigrations` and `layerStorage`
 * to migrate separately.
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layerWith = (options: {
  readonly prefix?: string | undefined
}): Layer.Layer<MessageStorage.MessageStorage, never, SqlClient.SqlClient | ShardingConfig | Digest.Digest> =>
  layerStorage(options).pipe(
    Layer.provide(layerMigrations(options))
  )

/**
 * Provides SQL-backed `MessageStorage` with the `cluster` table prefix,
 * running migrations first and supplying `Snowflake.layerGenerator`.
 *
 * **Details**
 *
 * The connection needs DDL permissions. PostgreSQL takes an exclusive lock
 * on the migration history table. Use `layerWith` for a custom prefix or
 * `layerMigrations` and `layerStorage` to migrate separately.
 *
 * @stability unstable
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  MessageStorage.MessageStorage,
  never,
  SqlClient.SqlClient | ShardingConfig | Digest.Digest
> = layerWith({})

// -------------------------------------------------------------------------------------------------
// internal
// -------------------------------------------------------------------------------------------------

const messageKind = {
  "Request": 0,
  "AckChunk": 1,
  "Interrupt": 2
} as const satisfies Record<Envelope.Envelope.Any["_tag"], number>

const replyKind = {
  "WithExit": 0,
  "Chunk": null
} as const satisfies Record<Reply.Reply<any>["_tag"], number | null>

const replyFromRow = (row: ReplyRow): Reply.Encoded =>
  row.kind !== null && Number(row.kind) === replyKind.WithExit ?
    {
      _tag: "WithExit",
      id: String(row.id),
      requestId: String(row.request_id),
      exit: JSON.parse(row.payload)
    } :
    {
      _tag: "Chunk",
      id: String(row.id),
      requestId: String(row.request_id),
      values: JSON.parse(row.payload),
      sequence: Number(row.sequence!)
    }

type MessageRow = {
  readonly id: string | bigint
  readonly message_id: string | null
  readonly shard_id: string
  readonly entity_type: string
  readonly entity_id: string
  readonly kind: 0 | 1 | 2 | 0n | 1n | 2n
  readonly tag: string | null
  readonly payload: string | null
  readonly headers: string | null
  readonly trace_id: string | null
  readonly span_id: string | null
  readonly sampled: boolean | number | bigint | null
  readonly request_id: string | bigint | null
  readonly reply_id: string | bigint | null
  readonly deliver_at: number | bigint | null
}

type ReplyRow = {
  readonly id: string | bigint
  readonly kind: 0 | null | 0n
  readonly request_id: string | bigint
  readonly payload: string
  readonly sequence: number | bigint | null
}

type ReplyJoinRow = {
  readonly reply_reply_id: string | bigint | null
  readonly reply_payload: string | null
  readonly reply_sequence: number | bigint | null
}

type MessageJoinRow = MessageRow & ReplyJoinRow & {
  readonly sequence: number | bigint
}
