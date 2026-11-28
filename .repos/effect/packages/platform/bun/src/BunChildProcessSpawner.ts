/**
 * Bun implementation of `ChildProcessSpawner`.
 *
 * @stability unstable
 * @since 4.0.0
 */
export {
  /**
   * Flattens a `Command` into its `StandardCommand`s along with the pipe
   * options for each connection.
   *
   * @stability unstable
   * @category re-exports
   * @since 4.0.0
   */
  flattenCommand,
  /**
   * Result of flattening a pipeline of commands.
   *
   * @stability unstable
   * @category re-exports
   * @since 4.0.0
   */
  type FlattenedPipeline,
  /**
   * Layer that provides the shared Node-compatible `ChildProcessSpawner`
   * implementation.
   *
   * @stability unstable
   * @category re-exports
   * @since 4.0.0
   */
  layer
} from "@effect/platform-node-shared/NodeChildProcessSpawner"
