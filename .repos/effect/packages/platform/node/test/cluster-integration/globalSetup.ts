import { MySqlContainer } from "@testcontainers/mysql"
import { PostgreSqlContainer } from "@testcontainers/postgresql"
import type { TestProject } from "vitest/node"

export interface ClusterDatabases {
  readonly mysql: string
  readonly pg: string
}

declare module "vitest" {
  export interface ProvidedContext {
    readonly clusterDatabases: ClusterDatabases
  }
}

// Commits on these throwaway databases skip the disk flush: a slow flush can
// hold a lock refresh past the harness's 500 ms `shardLockRefreshInterval`,
// which fences a reply and replays its request. Smoke.test.ts checks the
// settings.
const makePostgresContainer = () =>
  new PostgreSqlContainer("postgres:alpine").withCommand(["postgres", "-c", "fsync=off"])

const makeMysqlContainer = () =>
  new MySqlContainer("mysql:lts").withCommand([
    "--innodb-flush-log-at-trx-commit=0",
    "--sync-binlog=0"
  ]).withHealthCheck({
    test: [
      "CMD-SHELL",
      "MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\" mysqladmin ping --protocol TCP --host 127.0.0.1 --user root --silent"
    ],
    interval: 250,
    timeout: 1000,
    retries: 1000
  })

export default function setup(project: TestProject) {
  return Promise.all([
    makePostgresContainer().start(),
    makeMysqlContainer().start()
  ]).then(([pg, mysql]) => {
    project.provide("clusterDatabases", {
      mysql: mysql.getConnectionUri(),
      pg: pg.getConnectionUri()
    })
    return () => Promise.all([pg.stop(), mysql.stop()]).then(() => undefined)
  })
}
