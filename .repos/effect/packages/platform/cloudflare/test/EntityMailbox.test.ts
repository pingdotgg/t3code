import {
  clearReplies,
  EncodedMessageTooLargeError,
  loadUnprocessed,
  MailboxFullError,
  maximumEncodedSize,
  persistRequest,
  saveReply
} from "@effect/platform-cloudflare/internal/entityMailbox"
import { ensureEntityStorage } from "@effect/platform-cloudflare/internal/entityStorage"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { DatabaseSync } from "node:sqlite"
import { SqliteStorage } from "./fixtures/sqliteStorage.ts"

const requestId = "0198bd72-6a80-72f1-8d87-5e9b5cf1e000"
const envelope = JSON.stringify({
  _tag: "Request",
  requestId,
  address: {
    shardId: { group: "default", id: 1 },
    entityType: "Counter",
    entityId: "one"
  },
  tag: "Increment",
  payload: { amount: 1 },
  headers: {}
})

const withRequestId = (id: string) => JSON.stringify({ ...JSON.parse(envelope), requestId: id })

const chunk = (id: string, values: ReadonlyArray<unknown> = [1]) =>
  JSON.stringify({ _tag: "Chunk", requestId, id, sequence: 0, values })

const makeMailbox = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (database) => Effect.sync(() => database.close())
).pipe(Effect.map((database) => {
  const storage = new SqliteStorage(database)
  ensureEntityStorage(storage.sql)
  return storage.sql
}))

const fillUnprocessed = (sql: SqliteStorage["sql"], count: number) => {
  for (let index = 0; index < count; index++) {
    sql.exec("INSERT INTO cluster_messages (request_id, envelope) VALUES (?, ?)", `filler-${index}`, envelope)
  }
}

describe("EntityMailbox", () => {
  it.effect("rejects the 4097th unprocessed request", () =>
    Effect.gen(function*() {
      const sql = yield* makeMailbox
      fillUnprocessed(sql, 4096)

      assert.instanceOf(yield* Effect.flip(persistRequest(sql, envelope, null)), MailboxFullError)
    }))

  it.effect("counts a completed stream with an unacknowledged chunk against capacity", () =>
    Effect.gen(function*() {
      const sql = yield* makeMailbox
      fillUnprocessed(sql, 4095)
      yield* persistRequest(sql, envelope, null)
      yield* saveReply(sql, chunk("chunk"))
      yield* saveReply(
        sql,
        JSON.stringify({ _tag: "WithExit", requestId, id: "terminal", exit: { _tag: "Success", value: null } })
      )

      const error = yield* Effect.flip(persistRequest(sql, withRequestId("0198bd72-6a83-72f1-8d87-5e9b5cf1e003"), null))
      assert.instanceOf(error, MailboxFullError)
    }))

  it.effect("rejects an encoded reply chunk over 2 MB", () =>
    Effect.gen(function*() {
      const sql = yield* makeMailbox
      yield* persistRequest(sql, envelope, null)

      const error = yield* Effect.flip(saveReply(sql, chunk("large", ["x".repeat(maximumEncodedSize)])))
      assert.instanceOf(error, EncodedMessageTooLargeError)
    }))

  it.effect("replays an unprocessed row with its last sent chunk", () =>
    Effect.gen(function*() {
      const sql = yield* makeMailbox
      yield* persistRequest(sql, envelope, null)
      yield* saveReply(sql, chunk("chunk-1"))

      const [row] = yield* loadUnprocessed(sql)
      assert.strictEqual(row.lastSentChunk, chunk("chunk-1"))
    }))

  it.effect("clearReplies returns a request to the unprocessed queue without its replies", () =>
    Effect.gen(function*() {
      const sql = yield* makeMailbox
      yield* persistRequest(sql, envelope, null)
      yield* saveReply(
        sql,
        JSON.stringify({ _tag: "WithExit", requestId, id: "terminal", exit: { _tag: "Success", value: null } })
      )
      assert.deepStrictEqual(yield* loadUnprocessed(sql), [])

      yield* clearReplies(sql, requestId)
      const [row] = yield* loadUnprocessed(sql)
      assert.strictEqual(row.requestId, requestId)
      assert.isUndefined(row.lastSentChunk)
    }))
})
