import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Shared scaffolding for Amazon EMR HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the two
 * builders below. Everything except the operation, the IAM action list, and
 * the injected cluster identifier is boilerplate.
 */

/**
 * Build the impl Effect for a cluster-scoped operation. The deploy-time half
 * grants `actions` on the bound {@link Cluster}'s ARN (EMR authorizes
 * cluster-addressed actions against the cluster ARN); the runtime callable
 * injects the cluster's identifier into the request as `inject`:
 *
 * - `"ClusterId"` (default) / `"JobFlowId"` — the cluster id (`j-…`)
 * - `"TargetResourceArn"` — the cluster ARN (persistent app UIs)
 * - `"none"` — pass the caller's request through unchanged (id-addressed
 *   companions like `DescribePersistentAppUI` that EMR still authorizes
 *   against the cluster the target belongs to)
 */
export const makeEmrClusterHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EMR.DescribeStep`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the cluster ARN. */
  actions: readonly string[];
  /** Request field the bound cluster is injected as. */
  inject?: "ClusterId" | "JobFlowId" | "TargetResourceArn" | "none";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;
    const inject = options.inject ?? "ClusterId";

    return Effect.fn(function* <C extends Cluster>(cluster: C) {
      // Outputs yield a DEFERRED effect — resolve again per invocation below.
      const Injected = yield* inject === "TargetResourceArn"
        ? cluster.clusterArn
        : cluster.clusterId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: [Output.interpolate`${cluster.clusterArn}`],
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "ClusterId" | "JobFlowId" | "TargetResourceArn">,
      ) {
        return yield* op(
          (inject === "none"
            ? { ...request }
            : { ...request, [inject]: yield* Injected }) as I,
        );
      });
    });
  });

/**
 * Build the impl Effect for an account-level operation (cluster inventory,
 * release-label catalog). The deploy-time half grants `actions` on `*` —
 * these read-only discovery actions span every cluster/release label in the
 * account and support no resource-level scoping.
 */
export const makeEmrAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EMR.ListClusters`. */
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
