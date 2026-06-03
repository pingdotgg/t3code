/**
 * The `SingleRunner` module provides a ready-to-use layer for running the
 * cluster sharding services in a single process. It wires together sharding,
 * message storage, runner registration, runner health, and sharding
 * configuration so durable entities and workflows can run without a fleet of
 * external runners.
 *
 * **Common tasks**
 *
 * - Start a local or embedded cluster runner backed by SQL message storage
 * - Run durable entities and workflows in development, tests, or small
 *   single-node deployments
 * - Choose SQL runner storage for persistence or in-memory runner storage for
 *   short-lived scenarios
 * - Override sharding configuration while still using the standard
 *   environment-based defaults
 *
 * **Gotchas**
 *
 * - The layer still requires a `SqlClient` because message storage is SQL-backed
 * - Runner health and runner coordination are no-op implementations, so this is
 *   for single-node use rather than multi-runner cluster coordination
 *
 * @since 4.0.0
 */
import * as Layer from "effect/Layer"
import type { ConfigError } from "../../Config.ts"
import type * as SqlClient from "../sql/SqlClient.ts"
import type * as MessageStorage from "./MessageStorage.ts"
import * as RunnerHealth from "./RunnerHealth.ts"
import * as Runners from "./Runners.ts"
import * as RunnerStorage from "./RunnerStorage.ts"
import * as Sharding from "./Sharding.ts"
import * as ShardingConfig from "./ShardingConfig.ts"
import * as SqlMessageStorage from "./SqlMessageStorage.ts"
import * as SqlRunnerStorage from "./SqlRunnerStorage.ts"

/**
 * Provides a SQL-backed single-node cluster for running durable
 * entities and workflows.
 *
 * **When to use**
 *
 * Use to run durable cluster entities and workflows in a local, embedded, or
 * small single-node process while keeping mailbox and reply state in SQL.
 *
 * **Details**
 *
 * The layer provides `Sharding`, `Runners`, and `MessageStorage`. It loads
 * `ShardingConfig` from environment variables and overlays
 * `options.shardingConfig` when provided. Message storage is always SQL-backed;
 * runner storage is SQL-backed by default and switches to in-memory storage
 * when `runnerStorage` is set to `"memory"`.
 *
 * **Gotchas**
 *
 * - Even when `runnerStorage` is `"memory"`, message storage remains
 *   SQL-backed, so callers must still provide `SqlClient`.
 * - Runner communication and runner health are no-op services, so this layer is
 *   for single-process use rather than multi-runner coordination.
 *
 * @see {@link ShardingConfig.layerFromEnv} for loading environment configuration before applying `shardingConfig` overrides
 * @see {@link SqlMessageStorage.layer} for the SQL-backed message storage that this layer provides
 * @see {@link SqlRunnerStorage.layer} for the default SQL-backed runner storage selected when `runnerStorage` is omitted or `"sql"`
 * @see {@link RunnerStorage.layerMemory} for the in-memory runner storage selected by `runnerStorage: "memory"`
 *
 * @category layers
 * @since 4.0.0
 */
export const layer = (options?: {
  readonly shardingConfig?: Partial<ShardingConfig.ShardingConfig["Service"]> | undefined
  readonly runnerStorage?: "memory" | "sql" | undefined
}): Layer.Layer<
  | Sharding.Sharding
  | Runners.Runners
  | MessageStorage.MessageStorage,
  ConfigError,
  SqlClient.SqlClient
> =>
  Sharding.layer.pipe(
    Layer.provideMerge(Runners.layerNoop),
    Layer.provideMerge(SqlMessageStorage.layer),
    Layer.provide([
      options?.runnerStorage === "memory" ? RunnerStorage.layerMemory : Layer.orDie(SqlRunnerStorage.layer),
      RunnerHealth.layerNoop
    ]),
    Layer.provide(ShardingConfig.layerFromEnv(options?.shardingConfig))
  )
