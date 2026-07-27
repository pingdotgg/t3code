import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Shared scaffolding for AWS DocDBElastic HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate.
 */

/**
 * Elastic-cluster snapshot ARNs embed a server-generated UUID that is only
 * known at runtime, so snapshot-scoped grants use this wildcard.
 */
export const SNAPSHOT_ARN_WILDCARD =
  "arn:aws:docdb-elastic:*:*:cluster-snapshot/*";

/**
 * Build the impl Effect for an account-level operation (snapshot management,
 * restore, pending maintenance). The deploy-time half grants `actions` on
 * `resources` (default `*`) — these operations address snapshots and
 * clusters by ARNs that are runtime data.
 */
export const makeDocDBElasticAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DocDBElastic.GetClusterSnapshot`. */
  tag: string;
  /** The distilled operation, invoked with the caller's request as-is. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted. */
  actions: readonly string[];
  /**
   * IAM resources the actions are granted on.
   * @default ["*"]
   */
  resources?: readonly string[];
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
                Resource: [...(options.resources ?? ["*"])],
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

/**
 * Build the impl Effect for a cluster-scoped operation: the runtime callable
 * injects the bound {@link Cluster}'s ARN as `clusterArn` and the deploy-time
 * half grants `actions` on the cluster ARN (plus any `extraResources`).
 */
export const makeDocDBElasticClusterHttpBinding = <
  I extends { clusterArn: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.DocDBElastic.StopCluster`. */
  tag: string;
  /** The distilled operation; `clusterArn` is injected from the cluster. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the cluster ARN. */
  actions: readonly string[];
  /** Static IAM resources granted in addition to the cluster ARN. */
  extraResources?: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (cluster: Cluster) {
      const clusterArn = yield* cluster.clusterArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [
                  Output.interpolate`${cluster.clusterArn}`,
                  ...(options.extraResources ?? []),
                ],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "clusterArn">,
      ) {
        return yield* op({
          ...request,
          clusterArn: yield* clusterArn,
        } as I);
      });
    });
  });
