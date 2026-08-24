import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { Cluster } from "./Cluster.ts";
import type { Service } from "./Service.ts";
import { isTask, type Task } from "./Task.ts";

/**
 * Shared scaffolding for AWS ECS HTTP bindings.
 *
 * NOT exported from `index.ts` — every `{Op}Http.ts` in this service is a
 * thin `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the three
 * builders below. Everything except the operation, the IAM action list, and
 * the IAM resource scope is boilerplate.
 *
 * ECS scopes cluster-addressed actions against sub-resource ARNs derived
 * from the cluster ARN — `arn:…:task/{clusterName}/*`,
 * `arn:…:service/{clusterName}/*`, `arn:…:container-instance/{clusterName}/*`
 * — or, for list actions with no usable resource type on Fargate, against
 * `*` conditioned on the bound cluster.
 */

/**
 * `iam:PassRole` pre-typed as `string[]` (a declared alternative of
 * `PolicyStatement.Action`). A fresh literal array at the `host.bind` call
 * site would be contextually typed against `Input<IamAction[] | string[]>`
 * across the `Function | Task` host union, forcing normalization of the
 * ~18k-literal `IamAction` union and tripping TS2590 ("union type too
 * complex") under TypeScript 7.
 */
const passRoleActions: string[] = ["iam:PassRole"];

/** IAM resource scopes for cluster-bound ECS operations. */
export type EcsClusterIamResource =
  | "cluster"
  | "task"
  | "service"
  | "container-instance";

const clusterSubresourcePattern = (
  cluster: Cluster,
  kind: Exclude<EcsClusterIamResource, "cluster">,
) =>
  Output.map(
    cluster.clusterArn,
    (arn) => `${arn.replace(":cluster/", `:${kind}/`)}/*`,
  );

const clusterIamResources = (
  cluster: Cluster,
  resources: readonly EcsClusterIamResource[],
) =>
  resources.map((kind) =>
    kind === "cluster"
      ? Output.interpolate`${cluster.clusterArn}`
      : clusterSubresourcePattern(cluster, kind),
  );

/**
 * Build the impl Effect for a cluster-addressed operation whose request
 * carries a `cluster` field: the runtime callable injects the bound
 * {@link Cluster}'s ARN and the deploy-time half grants `actions` on the
 * requested `resources` scopes (or on `*` conditioned on the bound cluster
 * when `resources` is `"cluster-condition"` — for list actions that have no
 * usable resource type on Fargate).
 */
export const makeEcsClusterHttpBinding = <
  I extends { cluster?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ECS.DescribeServices`. */
  tag: string;
  /** The distilled operation; `cluster` is injected from the bound cluster. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted. */
  actions: readonly string[];
  /** IAM resource scopes derived from the cluster ARN. */
  resources: readonly EcsClusterIamResource[] | "cluster-condition";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (cluster: Cluster) {
      const ClusterArn = yield* cluster.clusterArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${cluster}))`({
            policyStatements: [
              options.resources === "cluster-condition"
                ? {
                    Effect: "Allow",
                    Action: [...options.actions],
                    Resource: ["*"],
                    Condition: {
                      ArnEquals: { "ecs:cluster": cluster.clusterArn },
                    },
                  }
                : {
                    Effect: "Allow",
                    Action: [...options.actions],
                    Resource: clusterIamResources(cluster, options.resources),
                  },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${cluster.LogicalId})`)(function* (
        request: Omit<I, "cluster">,
      ) {
        return yield* op({
          ...request,
          cluster: yield* ClusterArn,
        } as I);
      });
    });
  });

/**
 * Build the impl Effect for a task-launch operation (`RunTask`/`StartTask`):
 * the runtime callable injects the bound {@link Cluster}'s ARN as `cluster`
 * and the bound {@link Task}'s definition ARN as `taskDefinition`; the
 * deploy-time half grants `actions` on the task definition plus
 * `iam:PassRole` on the task and execution roles.
 */
export const makeEcsTaskLaunchHttpBinding = <
  I extends { cluster?: string; taskDefinition: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ECS.RunTask`. */
  tag: string;
  /** The distilled operation; `cluster` + `taskDefinition` are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the task definition ARN. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (cluster: Cluster, task: Task) {
      const ClusterArn = yield* cluster.clusterArn;
      const TaskDefinitionArn = yield* task.taskDefinitionArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${cluster}, ${task}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [task.taskDefinitionArn],
                },
                {
                  Effect: "Allow",
                  Action: passRoleActions,
                  Resource: [task.taskRoleArn, task.executionRoleArn],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `${options.tag}(${cluster.LogicalId}, ${task.LogicalId})`,
      )(function* (request: Omit<I, "cluster" | "taskDefinition">) {
        return yield* op({
          ...request,
          cluster: yield* ClusterArn,
          taskDefinition: yield* TaskDefinitionArn,
        } as I);
      });
    });
  });

/** IAM resource scopes for service-bound ECS operations. */
export type EcsServiceIamResource =
  | "service"
  | "service-deployment"
  | "service-revision";

const serviceIamResources = (
  service: Service,
  resources: readonly EcsServiceIamResource[],
) =>
  resources.map((kind) =>
    kind === "service"
      ? Output.interpolate`${service.serviceArn}`
      : Output.map(
          service.serviceArn,
          (arn) => `${arn.replace(":service/", `:${kind}/`)}/*`,
        ),
  );

/**
 * Build the impl Effect for a service-addressed operation (deployment
 * observation and blue/green lifecycle-hook control). The deploy-time half
 * grants `actions` on the requested scopes derived from the bound
 * {@link Service}'s ARN. When `inject` is set, the runtime callable injects
 * the service ARN as `service` and the cluster ARN as `cluster`; otherwise
 * the request passes through as-is (deployment/revision ARNs are only known
 * at runtime).
 */
export const makeEcsServiceHttpBinding = <I, A, E, R>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.ECS.StopServiceDeployment`. */
  tag: string;
  /** The distilled operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted. */
  actions: readonly string[];
  /** IAM resource scopes derived from the service ARN. */
  resources: readonly EcsServiceIamResource[];
  /** Inject `service` (service ARN) + `cluster` (cluster ARN) into requests. */
  inject?: boolean;
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (service: Service) {
      const ServiceArn = yield* service.serviceArn;
      const ClusterArn = yield* service.clusterArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host) || isTask(host)) {
          yield* host.bind`Allow(${host}, ${options.tag}(${service}))`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: [...options.actions],
                Resource: serviceIamResources(service, options.resources),
              },
            ],
          });
        }
      }
      return Effect.fn(`${options.tag}(${service.LogicalId})`)(function* (
        request: Omit<I, "service" | "cluster">,
      ) {
        return yield* op(
          (options.inject
            ? {
                ...request,
                service: yield* ServiceArn,
                cluster: yield* ClusterArn,
              }
            : request) as I,
        );
      });
    });
  });
