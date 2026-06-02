/**
 * The `TestRunner` module assembles the smallest cluster runtime useful in
 * tests: `Sharding` backed by in-memory message storage, in-memory runner
 * storage, no-op runner transport, and always-healthy runner checks. It lets
 * code that depends on cluster services exercise registration, shard
 * coordination, and mailbox persistence without starting RPC servers or
 * external databases.
 *
 * **Mental model**
 *
 * The layer behaves like a single in-process runner using the default
 * `ShardingConfig`. Sharding still computes shard ids, acquires in-memory shard
 * locks, stores persisted messages, and emits registration events, but remote
 * runner communication is deliberately absent.
 *
 * **Common tasks**
 *
 * - Provide cluster services around tests for sharded entities and singletons
 * - Exercise persisted mailbox behavior with the in-memory message store
 * - Observe registration events without starting a real runner process
 *
 * **Gotchas**
 *
 * - State is scoped to each layer instance and disappears when the layer closes
 * - No-op runner transport cannot deliver work to another process, so
 *   multi-runner tests should provide their own `Runners` implementation
 * - No-op health checks treat every runner as healthy and do not model
 *   failure-driven rebalancing
 *
 * @since 4.0.0
 */
import * as Layer from "../../Layer.ts"
import * as MessageStorage from "./MessageStorage.ts"
import * as RunnerHealth from "./RunnerHealth.ts"
import * as Runners from "./Runners.ts"
import * as RunnerStorage from "./RunnerStorage.ts"
import * as Sharding from "./Sharding.ts"
import * as ShardingConfig from "./ShardingConfig.ts"

/**
 * Layer that provides an in-memory cluster for testing.
 *
 * **Details**
 *
 * `MessageStorage` and `RunnerStorage` are backed by in-memory drivers.
 *
 * @category layers
 * @since 4.0.0
 */
export const layer: Layer.Layer<
  Sharding.Sharding | Runners.Runners | MessageStorage.MessageStorage | MessageStorage.MemoryDriver
> = Sharding.layer.pipe(
  Layer.provideMerge(Runners.layerNoop),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provide([RunnerStorage.layerMemory, RunnerHealth.layerNoop]),
  Layer.provide(ShardingConfig.layer())
)
