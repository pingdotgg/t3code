/**
 * The `ClusterSchema` module collects the annotations that add cluster behavior
 * to RPC protocols and entity definitions. These annotations describe how
 * requests are persisted, handled in transactions, interrupted, traced, and
 * routed to shard groups without changing the request or response schema.
 *
 * **Mental model**
 *
 * - An annotation is protocol metadata read by the cluster runtime.
 * - Static annotations apply to every request covered by the annotated RPC or
 *   entity.
 * - {@link Dynamic} can adjust server-side annotations from the decoded request
 *   that is already part of the protocol.
 *
 * **Common tasks**
 *
 * - Mark requests for durable mailbox storage with {@link Persisted}.
 * - Wrap server handling and storage work in the configured storage transaction
 *   with {@link WithTransaction}.
 * - Decide whether client sending, server handling, or both ignore interruption
 *   with {@link Uninterruptible}.
 * - Route entity ids into shard groups with {@link ShardGroup}.
 * - Disable client tracing for internal or high-volume protocols with
 *   {@link ClientTracingEnabled}.
 * - Derive request annotations from the request value with {@link Dynamic}.
 *
 * **Gotchas**
 *
 * - Persisted requests require message storage that can save mailbox messages
 *   and replies.
 * - {@link WithTransaction} only has transactional behavior when the configured
 *   storage layer implements transactions.
 * - Shard group functions must be deterministic for the same entity id across
 *   all runners that share a cluster.
 * - {@link Dynamic} affects entity-side request handling, not the generated
 *   client.
 *
 * **See also**
 *
 * - {@link Persisted}, {@link WithTransaction}, and {@link Uninterruptible} for
 *   delivery and handling behavior.
 * - {@link ShardGroup} for shard-group selection.
 * - {@link Dynamic} for deriving annotations from a request.
 *
 * @since 4.0.0
 */
import * as Context from "../../Context.ts"
import { constFalse, constTrue, identity } from "../../Function.ts"
import type * as Rpc from "../rpc/Rpc.ts"
import type { EntityId } from "./EntityId.ts"
import type { Request } from "./Envelope.ts"

/**
 * Annotation that marks whether a cluster request should be persisted in mailbox
 * storage.
 *
 * **Details**
 *
 * The default value is `false`.
 *
 * @category annotations
 * @since 4.0.0
 */
export const Persisted = Context.Reference<boolean>("effect/cluster/ClusterSchema/Persisted", {
  defaultValue: constFalse
})

/**
 * Annotation that marks whether request handling should be wrapped in the
 * configured message storage transaction.
 *
 * **When to use**
 *
 * Use when a request needs server-side handling or storage work wrapped in the
 * storage transaction.
 *
 * **Details**
 *
 * The default value is `false`. When `true`, entity handling wraps server
 * writes with the configured storage transaction.
 *
 * **Gotchas**
 *
 * This annotation has transactional behavior only when the configured
 * `MessageStorage` implements it.
 *
 * @category annotations
 * @since 4.0.0
 */
export const WithTransaction = Context.Reference<boolean>(
  "effect/cluster/ClusterSchema/WithTransaction",
  { defaultValue: constFalse }
)

/**
 * Annotation that controls whether a cluster request is treated as
 * uninterruptible.
 *
 * **Details**
 *
 * Use `true` for both client and server handling, `"client"` for client-side
 * handling only, `"server"` for server-side handling only, or `false` to allow
 * interruption.
 *
 * @category annotations
 * @since 4.0.0
 */
export const Uninterruptible = Context.Reference<boolean | "client" | "server">(
  "effect/cluster/ClusterSchema/Uninterruptible",
  { defaultValue: constFalse }
)

/**
 * Returns whether the `Uninterruptible` annotation applies to server-side
 * request handling for the provided context.
 *
 * **Details**
 *
 * Returns `true` only when `Uninterruptible` is `true` or `"server"`.
 *
 * @see {@link Uninterruptible} for the annotation values interpreted by this helper
 * @see {@link isUninterruptibleForClient} for the client-side counterpart
 *
 * @category annotations
 * @since 4.0.0
 */
export const isUninterruptibleForServer = (context: Context.Context<never>): boolean => {
  const value = Context.get(context, Uninterruptible)
  return value === true || value === "server"
}

/**
 * Returns whether the `Uninterruptible` annotation applies to client-side
 * request handling for the provided context.
 *
 * **When to use**
 *
 * Use when client-side cluster request handling needs to decide whether an
 * interrupt should be ignored.
 *
 * **Details**
 *
 * Returns `true` when `Uninterruptible` is `true` or `"client"`, and `false`
 * for `"server"` or the default `false`.
 *
 * @see {@link Uninterruptible} for the annotation values interpreted by this helper
 * @see {@link isUninterruptibleForServer} for the server-side counterpart
 *
 * @category annotations
 * @since 4.0.0
 */
export const isUninterruptibleForClient = (context: Context.Context<never>): boolean => {
  const value = Context.get(context, Uninterruptible)
  return value === true || value === "client"
}

/**
 * Annotation that selects the shard group for an entity id.
 *
 * **Details**
 *
 * By default, every entity id is assigned to the `"default"` shard group.
 *
 * @category annotations
 * @since 4.0.0
 */
export const ShardGroup = Context.Reference<(entityId: EntityId) => string>(
  "effect/cluster/ClusterSchema/ShardGroup",
  { defaultValue: () => (_) => "default" }
)

/**
 * Annotation that controls whether client-side cluster request tracing is
 * enabled.
 *
 * **Details**
 *
 * The default value is `true`.
 *
 * @category annotations
 * @since 4.0.0
 */
export const ClientTracingEnabled = Context.Reference<boolean>("effect/cluster/ClusterSchema/ClientTracingEnabled", {
  defaultValue: constTrue
})

/**
 * Context reference for deriving request annotations from a cluster request.
 *
 * **When to use**
 *
 * Use to customize server-side request annotations based on the decoded
 * request value.
 *
 * **Gotchas**
 *
 * This only applies to requests handled by the entity, not to the generated
 * client.
 *
 * @category annotations
 * @since 4.0.0
 */
export const Dynamic = Context.Reference<
  (annotations: Context.Context<never>, request: Request<Rpc.AnyWithProps>) => Context.Context<never>
>(
  "effect/cluster/ClusterSchema/Dynamic",
  { defaultValue: () => identity }
)
