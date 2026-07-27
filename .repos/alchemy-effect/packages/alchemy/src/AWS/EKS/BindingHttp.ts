import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Shared scaffolding for AWS EKS HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, makeEKS…HttpBinding({ … }))` over one of the
 * builders below. Everything except the operation, the request key carrying
 * the cluster name, and the IAM action list is boilerplate.
 */

/**
 * Build the impl Effect for an account-level operation (cluster enumeration,
 * managed access-policy catalog, Kubernetes/add-on version catalogs). The
 * deploy-time half grants `actions` on `*` — these read-only catalog and
 * enumeration actions span the whole account/region and take no resource ARN.
 */
export const makeEKSAccountHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EKS.ListClusters`. */
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

/**
 * Which ARNs an action authorizes against, per the EKS service authorization
 * reference:
 *
 * - `cluster` — the cluster ARN itself (`DescribeCluster`, the `List*`
 *   enumerations, insights).
 * - `subresources` — the cluster's sub-resources. Nodegroups, add-ons,
 *   Fargate profiles, pod identity associations, and access entries all share
 *   the ARN shape `arn:aws:eks:{region}:{acct}:{type}/{clusterName}/…`, so a
 *   single wildcard pattern derived from the cluster ARN (resource type
 *   replaced by a `*` and a trailing `/{star}` appended) covers them without
 *   granting anything on other clusters.
 * - `both` — actions like `ListUpdates`/`DescribeUpdate` that authorize
 *   against the cluster OR a sub-resource depending on the request.
 */
export type EKSIamScope = "cluster" | "subresources" | "both";

const scopeResources = (cluster: Cluster, scope: EKSIamScope) => {
  const clusterArn = Output.interpolate`${cluster.clusterArn}`;
  const subresources = Output.map(
    cluster.clusterArn,
    (arn: string): string => `${arn.replace(":cluster/", ":*/")}/*`,
  );
  return scope === "cluster"
    ? [clusterArn]
    : scope === "subresources"
      ? [subresources]
      : [clusterArn, subresources];
};

/**
 * Build the impl Effect for a cluster-scoped operation: the runtime callable
 * injects the bound {@link Cluster}'s name under `key` (`clusterName` for the
 * sub-resource lists and insights, `name` for `DescribeCluster`) and the
 * deploy-time half grants `actions` on the cluster ARN and/or its
 * sub-resource ARNs per `scope`.
 */
export const makeEKSClusterHttpBinding = <
  I extends { clusterName?: string } | { name?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.EKS.ListNodegroups`. */
  tag: string;
  /** The distilled operation; the cluster name is injected from the cluster. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted per `scope`. */
  actions: readonly string[];
  /** Request key carrying the cluster name. */
  key: "clusterName" | "name";
  /** Which ARNs the actions authorize against. */
  scope: EKSIamScope;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (cluster: Cluster) {
      const clusterName = yield* cluster.clusterName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${cluster}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: scopeResources(cluster, options.scope),
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "clusterName" | "name">,
      ) {
        return yield* op({
          ...request,
          [options.key]: yield* clusterName,
        } as I);
      });
    });
  });
