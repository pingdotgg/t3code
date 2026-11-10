import * as Effect from "effect/Effect";
import * as GCPBindings from "../GCPBindings.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";
import type { Cluster } from "./Cluster.ts";

/**
 * Shared HTTP scaffolding for Dataproc cluster bindings.
 * NOT exported from index.ts.
 */
export const makeDataprocClusterHttpBinding = <
  I extends { projectId?: string; region?: string; clusterName?: string },
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
    return Effect.fn(function* (cluster: Cluster) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${cluster})`({
          iam: [grantFor(options.iam, cluster.name)],
        });
      }
      const clusterName = yield* cluster.clusterName;
      const region = yield* cluster.region;
      const project = yield* cluster.project;
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request?: Omit<I, "projectId" | "region" | "clusterName">,
      ) {
        return yield* run({
          ...(request as I),
          clusterName: yield* clusterName,
          region: yield* region,
          projectId: yield* project,
        } as I);
      });
    });
  });
