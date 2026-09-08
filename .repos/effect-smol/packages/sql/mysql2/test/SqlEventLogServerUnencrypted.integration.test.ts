import * as SqlEventLogServerUnencryptedStorageTest from "effect-test/unstable/eventlog/SqlEventLogServerUnencryptedStorageTest"
import { MysqlContainer } from "./utils.ts"

SqlEventLogServerUnencryptedStorageTest.suite(
  "sql-mysql2",
  MysqlContainer.layerClient
)
