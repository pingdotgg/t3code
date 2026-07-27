import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { ReplicationInstance } from "./ReplicationInstance.ts";

/**
 * Shared HTTP scaffolding for the DMS runtime bindings.
 *
 * Every capability follows the same shape — resolve the distilled operation,
 * register an IAM policy statement on the binding host, and return a runtime
 * callable. The only variation is the operation, the IAM action(s), and the
 * identifier(s) injected from the bound resource: an {@link Endpoint}'s ARN,
 * a {@link ReplicationInstance}'s ARN, both (connection-shaped operations
 * like `TestConnection`/`RefreshSchemas`), or none (account-level describes).
 *
 * DMS `Describe*` actions do not support resource-level IAM permissions, so
 * describe-shaped capabilities grant on `*`; mutating capabilities
 * (`TestConnection`, `RefreshSchemas`, `RebootReplicationInstance`) grant on
 * the bound resource ARN(s).
 *
 * NOT exported from `index.ts`.
 */

/**
 * Build the impl Effect for an endpoint-scoped operation: the runtime
 * callable injects the bound {@link Endpoint}'s ARN as `EndpointArn`. DMS
 * describe actions are not resource-scoped in IAM, so the deploy-time half
 * grants `actions` on `*`.
 */
export const makeDmsEndpointScopedHttpBinding = <
  I extends { EndpointArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DMS.DescribeSchemas`. */
  tag: string;
  /** The distilled operation; `EndpointArn` is injected from the resource. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*` (DMS describes are not resource-scoped). */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (endpoint: Endpoint) {
      const EndpointArn = yield* endpoint.endpointArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${endpoint}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${endpoint.LogicalId})`)(function* (
        request?: Omit<I, "EndpointArn">,
      ) {
        return yield* op({
          ...request,
          EndpointArn: yield* EndpointArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a replication-instance-scoped operation: the
 * runtime callable injects the bound {@link ReplicationInstance}'s ARN as
 * `ReplicationInstanceArn`. Mutating actions (`RebootReplicationInstance`)
 * support resource-level IAM and grant on the instance ARN; describe actions
 * grant on `*` (set `iam: "wildcard"`).
 */
export const makeDmsInstanceScopedHttpBinding = <
  I extends { ReplicationInstanceArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DMS.RebootReplicationInstance`. */
  tag: string;
  /** The distilled operation; `ReplicationInstanceArn` is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted. */
  actions: readonly string[];
  /**
   * `"resource"` grants on the instance ARN (actions with resource-level IAM
   * support); `"wildcard"` grants on `*` (DMS describes).
   */
  iam: "resource" | "wildcard";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (instance: ReplicationInstance) {
      const ReplicationInstanceArn = yield* instance.replicationInstanceArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${instance}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource:
                  options.iam === "resource"
                    ? [Output.interpolate`${instance.replicationInstanceArn}`]
                    : ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${instance.LogicalId})`)(function* (
        request?: Omit<I, "ReplicationInstanceArn">,
      ) {
        return yield* op({
          ...request,
          ReplicationInstanceArn: yield* ReplicationInstanceArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a connection-shaped operation that targets a
 * (replication instance, endpoint) pair — `TestConnection` and
 * `RefreshSchemas`. Both ARNs are injected from the bound resources and the
 * deploy-time half grants `actions` on both ARNs (these actions support
 * resource-level IAM on both resource types).
 */
export const makeDmsConnectionScopedHttpBinding = <
  I extends { ReplicationInstanceArn: string; EndpointArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DMS.TestConnection`. */
  tag: string;
  /** The distilled operation; both ARNs are injected from the resources. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the instance + endpoint ARNs. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (
      instance: ReplicationInstance,
      endpoint: Endpoint,
    ) {
      const ReplicationInstanceArn = yield* instance.replicationInstanceArn;
      const EndpointArn = yield* endpoint.endpointArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${instance}, ${endpoint}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [
                    Output.interpolate`${instance.replicationInstanceArn}`,
                    Output.interpolate`${endpoint.endpointArn}`,
                  ],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `${options.tag}(${instance.LogicalId}, ${endpoint.LogicalId})`,
      )(function* (
        request?: Omit<I, "ReplicationInstanceArn" | "EndpointArn">,
      ) {
        return yield* op({
          ...request,
          ReplicationInstanceArn: yield* ReplicationInstanceArn,
          EndpointArn: yield* EndpointArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for an account-level operation (no target resource).
 * The deploy-time half grants `actions` on `*`.
 */
export const makeDmsAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DMS.DescribeConnections`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on `*`. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}())`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: ["*"],
              },
            ],
          });
        }
      }
      return Effect.fn(options.tag)(function* (request?: I) {
        return yield* op((request ?? {}) as I);
      });
    });
  });
