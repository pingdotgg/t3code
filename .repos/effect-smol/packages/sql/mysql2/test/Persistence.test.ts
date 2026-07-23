import { Layer } from "effect"
import * as PersistedCacheTest from "effect-test/unstable/persistence/PersistedCacheTest"
import * as PersistedQueueTest from "effect-test/unstable/persistence/PersistedQueueTest"
import { PersistedQueue, Persistence } from "effect/unstable/persistence"
import { MysqlContainer } from "./utils.ts"

PersistedCacheTest.suite(
  "sql-mysql2-multi",
  Persistence.layerSqlMultiTable.pipe(Layer.provide(MysqlContainer.layerClient))
)

PersistedCacheTest.suite(
  "sql-mysql2-single",
  Persistence.layerSql.pipe(Layer.provide(MysqlContainer.layerClient))
)

PersistedQueueTest.suite(
  "sql-mysql2",
  PersistedQueue.layerStoreSql().pipe(
    Layer.provide(MysqlContainer.layerClient)
  )
)
