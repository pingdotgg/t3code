import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Layer } from "effect"
import * as CompactionTest from "effect-test/eventlog/EventLogServerEncryptedCompactionTest"
import * as EncryptedTest from "effect-test/eventlog/EventLogServerEncryptedTest"
import * as SqlEventLogServerEncryptedStorageTest from "effect-test/eventlog/SqlEventLogServerEncryptedStorageTest"
import * as Digest from "effect/crypto/Digest"
import * as EventLogEncryption from "effect/eventlog/EventLogEncryption"
import * as SqlEventLogServerEncrypted from "effect/eventlog/SqlEventLogServerEncrypted"
import { Reactivity } from "effect/reactivity"
import { SqlClient } from "effect/sql"
import { MssqlContainer } from "./utils.ts"

EncryptedTest.suite(
  "mssql",
  SqlEventLogServerEncrypted.layerStorage().pipe(
    Layer.provide([MssqlContainer.layerClient, Reactivity.layer, EventLogEncryption.layerSubtle, Digest.layerWebCrypto])
  )
)

SqlEventLogServerEncryptedStorageTest.suite("mssql", MssqlContainer.layerClient)

CompactionTest.suite(
  "mssql",
  (options) => SqlEventLogServerEncrypted.layerStorage(options).pipe(Layer.provide(Digest.layerWebCrypto)),
  MssqlContainer.layerClient
)

SqlEventLogServerEncryptedStorageTest.compactionSuite("mssql", MssqlContainer.layerClient)

// Succeeds once a request waits on a lock that session `spid` holds. Other
// sessions don't count, as SQL Server's background tasks block each other.
const blockedBy = Effect.fnUntraced(function*(spid: number) {
  const sql = yield* SqlClient.SqlClient
  while (true) {
    const [row] = yield* sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM sys.dm_exec_requests WHERE blocking_session_id = ${spid}`
    if (row.n > 0) return "waited"
    yield* Effect.sleep(20)
  }
})

it.layer(Layer.mergeAll(Digest.layerWebCrypto, MssqlContainer.layerClient), {
  timeout: "60 seconds",
  excludeTestServices: true
})(
  "SqlEventLogServerEncrypted tables (mssql)",
  (it) => {
    it.effect("opens a store while another instance is creating an index", () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const prefix = "indexing"
        const stores = `${prefix}_compaction_stores`
        yield* sql`CREATE TABLE ${sql(stores)} (scope NVARCHAR(36) PRIMARY KEY, next_sweep_at BIGINT NULL)`
        // Hold a separate index creation open, as an older instance would.
        const indexing = yield* Deferred.make<number>()
        yield* Effect.gen(function*() {
          yield* sql`CREATE INDEX ${sql(`${stores}_i0`)} ON ${sql(stores)} (next_sweep_at)`
          const [row] = yield* sql<{ spid: number }>`SELECT @@SPID AS spid`
          yield* Deferred.succeed(indexing, row.spid)
          return yield* Effect.never
        }).pipe(sql.withTransaction, Effect.forkScoped)
        const spid = yield* Deferred.await(indexing)

        const outcome = yield* Effect.race(
          SqlEventLogServerEncrypted.makeStorage({ entryTablePrefix: prefix }).pipe(
            Effect.as("opened"),
            Effect.scoped
          ),
          blockedBy(spid)
        )

        assert.strictEqual(outcome, "opened")
      }))
  }
)
