import * as Effect from "effect/Effect";
import type { WorkstationCluster } from "./WorkstationCluster.ts";
import type { WorkstationClustersWorkstationConfig } from "./WorkstationClustersWorkstationConfig.ts";
import type { WorkstationClustersWorkstationConfigsWorkstation } from "./WorkstationClustersWorkstationConfigsWorkstation.ts";
import { bindGcpHost } from "../Host.ts";
import { type BindingIam, type GcpHttpOp, grantFor } from "../HttpBinding.ts";

/**
 * Shared HTTP scaffolding for Cloud Workstations bindings.
 * NOT exported from index.ts.
 */
export const makeClusterHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (cluster: WorkstationCluster) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: cluster,
        iam: [grantFor(options.iam, cluster.name)],
      });
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

export const makeConfigHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (config: WorkstationClustersWorkstationConfig) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: config,
        iam: [grantFor(options.iam, config.name)],
      });
      const name = yield* config.name;
      return Effect.fn(`${options.tag}(${config.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeWorkstationHttpBinding = <
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (
      workstation: WorkstationClustersWorkstationConfigsWorkstation,
    ) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: workstation,
        iam: [grantFor(options.iam, workstation.name)],
      });
      const name = yield* workstation.name;
      return Effect.fn(`${options.tag}(${workstation.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...(request as I),
          name: yield* name,
        } as I);
      });
    });
  });

export const makeGenerateAccessTokenHttpBinding = <
  I extends { workstation?: string },
  A,
  E,
>(options: {
  tag: string;
  iam: BindingIam;
  operation: GcpHttpOp<I, A, E>;
}) =>
  Effect.gen(function* () {
    const run = yield* options.operation;
    return Effect.fn(function* (
      workstation: WorkstationClustersWorkstationConfigsWorkstation,
    ) {
      yield* bindGcpHost({
        tag: options.tag,
        resource: workstation,
        iam: [grantFor(options.iam, workstation.name)],
      });
      const name = yield* workstation.name;
      return Effect.fn(`${options.tag}(${workstation.LogicalId})`)(function* (
        request?: Omit<I, "workstation">,
      ) {
        return yield* run({
          ...(request as I),
          workstation: yield* name,
        } as I);
      });
    });
  });
