import { Layer } from "effect"
import * as PersistedCacheTest from "effect-test/unstable/persistence/PersistedCacheTest"
import { Persistence } from "effect/unstable/persistence"
import { MssqlContainer } from "./utils.ts"

PersistedCacheTest.suite(
  "sql-mssql-multi",
  Persistence.layerSqlMultiTable.pipe(Layer.provide(MssqlContainer.layerClient))
)

PersistedCacheTest.suite(
  "sql-mssql-single",
  Persistence.layerSql.pipe(Layer.provide(MssqlContainer.layerClient))
)
