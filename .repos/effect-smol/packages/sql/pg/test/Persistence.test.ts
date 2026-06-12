import { Layer } from "effect"
import * as PersistedCacheTest from "effect-test/unstable/persistence/PersistedCacheTest"
import * as PersistedQueueTest from "effect-test/unstable/persistence/PersistedQueueTest"
import { PersistedQueue, Persistence } from "effect/unstable/persistence"
import { PgContainer } from "./utils.ts"

PersistedCacheTest.suite(
  "sql-pg-multi",
  Persistence.layerSqlMultiTable.pipe(Layer.provide(PgContainer.layerClient))
)

PersistedCacheTest.suite(
  "sql-pg-single",
  Persistence.layerSql.pipe(Layer.provide(PgContainer.layerClient))
)

PersistedQueueTest.suite(
  "sql-pg",
  PersistedQueue.layerStoreSql().pipe(Layer.provide(PgContainer.layerClient))
)
