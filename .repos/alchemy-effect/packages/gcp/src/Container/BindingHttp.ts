import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Cluster } from "./Cluster.ts";
import type { ClustersNodePool } from "./ClustersNodePool.ts";
import type { NodePool } from "./NodePool.ts";

/**
 * Shared HTTP scaffolding for GKE cluster and node pool bindings.
 * NOT exported from index.ts.
 */
export const makeContainerClusterHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (cluster: Cluster) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${cluster})`({
          iam: [grantFor(options.iam, cluster.name)],
        });
      }
      const name = yield* cluster.name;
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeContainerNodePoolHttpBinding = <I extends { name?: string }, A, E>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (nodePool: NodePool) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${nodePool})`({
          iam: [grantFor(options.iam, nodePool.name)],
        });
      }
      const name = yield* nodePool.name;
      return Effect.fn(`${options.tag}(${nodePool.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeContainerClustersNodePoolHttpBinding = <
  I extends {
    projectId: string;
    zone: string;
    clusterId: string;
    nodePoolId: string;
    name?: string;
  },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (nodePool: ClustersNodePool) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${nodePool})`({
          iam: [grantFor(options.iam, nodePool.name)],
        });
      }
      const name = yield* nodePool.name;
      const project = yield* nodePool.project;
      const zone = yield* nodePool.zone;
      const clusterId = yield* nodePool.clusterId;
      const nodePoolId = yield* nodePool.nodePoolId;
      return Effect.fn(`${options.tag}(${nodePool.LogicalId})`)(function* (
        request?: Omit<I, "projectId" | "zone" | "clusterId" | "nodePoolId" | "name">,
      ) {
        return yield* run({
          ...(request as I),
          projectId: yield* project,
          zone: yield* zone,
          clusterId: yield* clusterId,
          nodePoolId: yield* nodePoolId,
          name: yield* name,
        } as I);
      });
    });
  });
