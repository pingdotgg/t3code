import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Reference to an IAM role: a raw role ARN or anything exposing a `roleArn`
 * attribute (e.g. an `AWS.IAM.Role` resource).
 */
export type RoleRef = string | { roleArn: string };

export interface TaskDefinitionProps {
  /**
   * Task definition family. All revisions registered by this resource share
   * this family. If omitted, a unique family is generated.
   *
   * Changing the family replaces the resource.
   */
  family?: string;

  /**
   * Container definitions for the task (bring-your-own images: ECR
   * repository URIs, `public.ecr.aws/...`, Docker Hub, etc.).
   *
   * The first container is treated as the primary container: its `name` and
   * first `portMappings[].containerPort` are surfaced as the `containerName`
   * and `port` attributes so the task definition can be wired directly into
   * `AWS.ECS.Service`'s `task` prop.
   */
  containerDefinitions: ecs.ContainerDefinition[];

  /**
   * Task-level CPU units. Required by Fargate.
   * @default 256 when `requiresCompatibilities` includes `FARGATE`
   */
  cpu?: number | string;

  /**
   * Task-level memory (MiB). Required by Fargate.
   * @default 512 when `requiresCompatibilities` includes `FARGATE`
   */
  memory?: number | string;

  /**
   * IAM role assumed by the containers at runtime (application permissions).
   * Accepts a role ARN or an `AWS.IAM.Role` resource.
   */
  taskRoleArn?: RoleRef;

  /**
   * IAM role used by the ECS agent to pull images and ship logs. Accepts a
   * role ARN or an `AWS.IAM.Role` resource. Required by Fargate when private
   * registries or the `awslogs` log driver are used.
   */
  executionRoleArn?: RoleRef;

  /**
   * Docker network mode.
   * @default "awsvpc" when `requiresCompatibilities` includes `FARGATE`
   */
  networkMode?: ecs.NetworkMode;

  /**
   * Launch-type compatibilities the task definition must support
   * (`FARGATE` and/or `EC2`/`EXTERNAL`).
   * @default ["FARGATE"]
   */
  requiresCompatibilities?: ecs.Compatibility[];

  /**
   * Convenience CloudWatch Logs wiring. When set, Alchemy creates (and owns)
   * a log group and injects an `awslogs` `logConfiguration` into every
   * container definition that does not declare its own.
   *
   * `true` uses the default group name `/ecs/{family}`; pass an object to
   * override the group name or stream prefix. The log group is deleted when
   * the resource is destroyed.
   */
  awslogs?:
    | boolean
    | {
        /**
         * Log group name.
         * @default `/ecs/${family}`
         */
        group?: string;
        /**
         * awslogs stream prefix.
         * @default the task family
         */
        streamPrefix?: string;
      };

  /**
   * Task-level data volumes (host / docker / EFS / FSx Windows). Containers
   * reference these via `mountPoints`.
   */
  volumes?: ecs.Volume[];

  /**
   * Task definition placement constraints (`memberOf` expressions). Only
   * applies to EC2/EXTERNAL launch types.
   */
  placementConstraints?: ecs.TaskDefinitionPlacementConstraint[];

  /**
   * CPU architecture and operating-system family the task runs on, e.g.
   * `{ cpuArchitecture: "ARM64", operatingSystemFamily: "LINUX" }`.
   */
  runtimePlatform?: ecs.RuntimePlatform;

  /**
   * Amount of ephemeral storage to allocate for the task on Fargate.
   */
  ephemeralStorage?: ecs.EphemeralStorage;

  /**
   * IPC resource namespace to use for the containers in the task.
   */
  ipcMode?: ecs.IpcMode;

  /**
   * Process namespace to use for the containers in the task.
   */
  pidMode?: ecs.PidMode;

  /**
   * App Mesh proxy configuration.
   */
  proxyConfiguration?: ecs.ProxyConfiguration;

  /**
   * Elastic Inference accelerators to attach to the task.
   */
  inferenceAccelerators?: ecs.InferenceAccelerator[];

  /**
   * Whether to enable AWS Fault Injection (FIS) actions on the task.
   * @default false
   */
  enableFaultInjection?: boolean;

  /**
   * User-defined tags applied to each registered revision.
   */
  tags?: Record<string, string>;
}

export interface TaskDefinition extends Resource<
  "AWS.ECS.TaskDefinition",
  TaskDefinitionProps,
  {
    /**
     * ARN of the latest revision registered by this resource.
     */
    taskDefinitionArn: string;
    /**
     * Task definition family.
     */
    family: string;
    /**
     * Revision number of {@link taskDefinitionArn}.
     */
    revision: number;
    /**
     * Name of the primary (first) container — for `AWS.ECS.Service` wiring.
     */
    containerName: string;
    /**
     * First `containerPort` of the primary container (0 when the container
     * declares no port mappings) — for `AWS.ECS.Service` wiring.
     */
    port: number;
    /**
     * Resolved task role ARN, when configured.
     */
    taskRoleArn: string | undefined;
    /**
     * Resolved execution role ARN, when configured.
     */
    executionRoleArn: string | undefined;
    /**
     * Name of the Alchemy-managed log group, when `awslogs` is enabled.
     */
    logGroupName: string | undefined;
    /**
     * ARN of the Alchemy-managed log group, when `awslogs` is enabled.
     */
    logGroupArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A standalone ECS task definition for bring-your-own-container workloads.
 *
 * Unlike the Effect-native `AWS.ECS.Task` (which bundles an inline program and
 * builds/pushes a Docker image), `TaskDefinition` registers user-supplied
 * `containerDefinitions` — any image URI from ECR, `public.ecr.aws`, or an
 * external registry — with full control over Fargate/EC2 compatibility,
 * volumes, runtime platform, and IAM roles.
 *
 * Task definitions are immutable revisions under a family:
 *
 * - reconcile registers a **new revision only when the definition content
 *   changed** (compared against the observed latest `ACTIVE` revision), so a
 *   no-op redeploy keeps the same revision;
 * - changing the `family` replaces the resource;
 * - destroy deregisters and hard-deletes every revision of the family. ECS
 *   may retain referenced revisions in `DELETE_IN_PROGRESS` until their tasks
 *   and services terminate; that is a successful terminal state.
 *
 * **Layering — why `TaskDefinition` is deliberately *not* a Platform.** ECS
 * splits "what runs" from "how it runs": a task definition is the immutable
 * container spec, while `Task` (runs to completion) and `Service`
 * (long-running) are
 * the execution vehicles. The effectful Platform abstraction requires
 * Alchemy to own the container image and entrypoint so it can bundle the
 * inline Effect program — that is exactly what `AWS.ECS.Task` does (bundle →
 * Docker build/push → register definition → serve the program). Making
 * `TaskDefinition` *also* a Platform would duplicate `Task` while
 * contradicting this resource's purpose: user-supplied images whose
 * entrypoint Alchemy must not rewrite. So the effectful path is
 * `AWS.ECS.Task`; the bring-your-own-container path is `TaskDefinition`.
 * Both surface `taskDefinitionArn` / `containerName` / `port`, so either
 * plugs into `AWS.ECS.Service`'s `task` prop unchanged.
 * @resource
 * @section Creating a Task Definition
 * @example Public Image on Fargate
 * ```typescript
 * const taskDef = yield* TaskDefinition("Nginx", {
 *   containerDefinitions: [
 *     {
 *       name: "nginx",
 *       image: "public.ecr.aws/nginx/nginx:stable",
 *       essential: true,
 *       portMappings: [{ containerPort: 80, protocol: "tcp" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @example With IAM Roles and CloudWatch Logs
 * ```typescript
 * const taskDef = yield* TaskDefinition("Api", {
 *   cpu: 512,
 *   memory: 1024,
 *   taskRoleArn: taskRole,           // AWS.IAM.Role resource or raw ARN
 *   executionRoleArn: executionRole, // needed for awslogs / private images
 *   awslogs: true,                   // creates /ecs/{family} and injects awslogs config
 *   containerDefinitions: [
 *     {
 *       name: "api",
 *       image: image.imageUri,
 *       essential: true,
 *       portMappings: [{ containerPort: 8080 }],
 *       environment: [{ name: "STAGE", value: "prod" }],
 *     },
 *   ],
 * });
 * ```
 *
 * @section Running with a Service
 * @example Wire into AWS.ECS.Service
 * ```typescript
 * const service = yield* Service("ApiService", {
 *   cluster,
 *   task: taskDef, // exposes taskDefinitionArn / containerName / port
 *   vpcId: vpc.vpcId,
 *   subnets: [subnet.subnetId],
 *   assignPublicIp: true,
 * });
 * ```
 *
 * @section EC2 Launch Type
 * @example EC2 Task with a Host Volume
 * ```typescript
 * const taskDef = yield* TaskDefinition("Agent", {
 *   requiresCompatibilities: ["EC2"],
 *   networkMode: "bridge",
 *   volumes: [{ name: "docker-sock", host: { sourcePath: "/var/run/docker.sock" } }],
 *   containerDefinitions: [
 *     {
 *       name: "agent",
 *       image: "public.ecr.aws/docker/library/busybox:stable",
 *       memory: 128,
 *       essential: true,
 *       mountPoints: [{ sourceVolume: "docker-sock", containerPath: "/var/run/docker.sock" }],
 *     },
 *   ],
 * });
 * ```
 */
export const TaskDefinition = Resource<TaskDefinition>(
  "AWS.ECS.TaskDefinition",
);

// Deeply drop undefined-valued keys and empty arrays so that "not set" and
// "AWS returned nothing" compare equal.
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
};

// Compare the desired request against the observed task definition, treating
// the desired shape as a projection: keys the desired request does not set are
// ignored (AWS default-fills many fields — container `cpu: 0`, `essential`,
// empty collections, `requiresAttributes`, timestamps, ...). Removed props are
// caught separately by diffing the old desired request against the new one.
const projectionEquals = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return false;
    }
    return desired.every((d, i) => projectionEquals(d, observed[i]));
  }
  if (desired !== null && typeof desired === "object") {
    if (
      observed === null ||
      typeof observed !== "object" ||
      Array.isArray(observed)
    ) {
      return false;
    }
    return Object.entries(desired).every(([k, v]) =>
      projectionEquals(v, (observed as Record<string, unknown>)[k]),
    );
  }
  return desired === observed;
};

// Normalize container definitions on both sides before comparing: sort
// environment entries by name and fill the wire defaults AWS applies to port
// mappings (protocol "tcp"; in awsvpc mode hostPort mirrors containerPort).
const normalizeContainers = (
  defs: ecs.ContainerDefinition[] | undefined,
  networkMode: ecs.NetworkMode | undefined,
): ecs.ContainerDefinition[] =>
  (defs ?? []).map((cd) => ({
    ...cd,
    environment:
      cd.environment !== undefined && cd.environment.length > 0
        ? [...cd.environment].sort((a, b) =>
            (a.name ?? "").localeCompare(b.name ?? ""),
          )
        : undefined,
    portMappings: cd.portMappings?.map((pm) => ({
      ...pm,
      protocol: pm.protocol ?? "tcp",
      hostPort:
        networkMode === "awsvpc"
          ? (pm.hostPort ?? pm.containerPort)
          : pm.hostPort,
    })),
  }));

export const TaskDefinitionProvider = () =>
  Provider.effect(
    TaskDefinition,
    Effect.gen(function* () {
      const toFamily = (id: string, props: { family?: string } = {}) =>
        props.family
          ? Effect.succeed(props.family)
          : createPhysicalName({
              id,
              maxLength: 255,
              lowercase: true,
            });

      const roleArnOf = (ref: RoleRef | undefined): string | undefined =>
        typeof ref === "string"
          ? ref
          : typeof (ref as { roleArn?: unknown } | undefined)?.roleArn ===
              "string"
            ? (ref as { roleArn: string }).roleArn
            : undefined;

      const logGroupNameOf = (
        family: string,
        props: TaskDefinitionProps,
      ): string | undefined =>
        props.awslogs
          ? ((typeof props.awslogs === "object"
              ? props.awslogs.group
              : undefined) ?? `/ecs/${family}`)
          : undefined;

      // The desired registerTaskDefinition request (sans tags), fully
      // defaulted so it can be compared against the observed revision.
      const desiredRequestOf = (
        family: string,
        props: TaskDefinitionProps,
        region: string,
      ): Omit<ecs.RegisterTaskDefinitionRequest, "tags"> => {
        const requiresCompatibilities = props.requiresCompatibilities ?? [
          "FARGATE",
        ];
        const fargate = requiresCompatibilities.includes("FARGATE");
        const networkMode =
          props.networkMode ?? (fargate ? "awsvpc" : undefined);
        const logGroupName = logGroupNameOf(family, props);
        const streamPrefix =
          (typeof props.awslogs === "object"
            ? props.awslogs.streamPrefix
            : undefined) ?? family;
        const containerDefinitions = props.containerDefinitions.map((cd) =>
          logGroupName !== undefined && cd.logConfiguration === undefined
            ? {
                ...cd,
                logConfiguration: {
                  logDriver: "awslogs",
                  options: {
                    "awslogs-group": logGroupName,
                    "awslogs-region": region,
                    "awslogs-stream-prefix": streamPrefix,
                  },
                } satisfies ecs.LogConfiguration,
              }
            : cd,
        );
        return {
          family,
          taskRoleArn: roleArnOf(props.taskRoleArn),
          executionRoleArn: roleArnOf(props.executionRoleArn),
          networkMode,
          containerDefinitions,
          volumes: props.volumes,
          placementConstraints: props.placementConstraints,
          requiresCompatibilities,
          cpu:
            props.cpu !== undefined
              ? String(props.cpu)
              : fargate
                ? "256"
                : undefined,
          memory:
            props.memory !== undefined
              ? String(props.memory)
              : fargate
                ? "512"
                : undefined,
          pidMode: props.pidMode,
          ipcMode: props.ipcMode,
          proxyConfiguration: props.proxyConfiguration,
          inferenceAccelerators: props.inferenceAccelerators,
          ephemeralStorage: props.ephemeralStorage,
          runtimePlatform: props.runtimePlatform,
          enableFaultInjection: props.enableFaultInjection,
        };
      };

      const matchesObserved = (
        desired: Omit<ecs.RegisterTaskDefinitionRequest, "tags">,
        observed: ecs.TaskDefinition,
      ): boolean =>
        projectionEquals(
          canonicalize({
            ...desired,
            containerDefinitions: normalizeContainers(
              desired.containerDefinitions,
              desired.networkMode,
            ),
          }),
          canonicalize({
            family: observed.family,
            taskRoleArn: observed.taskRoleArn,
            executionRoleArn: observed.executionRoleArn,
            networkMode: observed.networkMode,
            containerDefinitions: normalizeContainers(
              observed.containerDefinitions,
              observed.networkMode,
            ),
            volumes: observed.volumes,
            placementConstraints: observed.placementConstraints,
            requiresCompatibilities: observed.requiresCompatibilities,
            cpu: observed.cpu,
            memory: observed.memory,
            pidMode: observed.pidMode,
            ipcMode: observed.ipcMode,
            proxyConfiguration: observed.proxyConfiguration,
            inferenceAccelerators: observed.inferenceAccelerators,
            ephemeralStorage: observed.ephemeralStorage,
            runtimePlatform: observed.runtimePlatform,
            enableFaultInjection: observed.enableFaultInjection,
          }),
        );

      const describeLatestActive = (taskDefinition: string) =>
        ecs.describeTaskDefinition({ taskDefinition }).pipe(
          Effect.map((described) =>
            described.taskDefinition?.status === "ACTIVE"
              ? described.taskDefinition
              : undefined,
          ),
          // "Unable to describe task definition" — no ACTIVE revision exists.
          Effect.catchTag("ClientException", () => Effect.succeed(undefined)),
        );

      const attrsOf = (
        td: ecs.TaskDefinition,
        logGroup: { logGroupName?: string; logGroupArn?: string } = {},
      ): TaskDefinition["Attributes"] | undefined => {
        if (!td.taskDefinitionArn || !td.family || td.revision === undefined) {
          return undefined;
        }
        const container = td.containerDefinitions?.[0];
        return {
          taskDefinitionArn: td.taskDefinitionArn,
          family: td.family,
          revision: td.revision,
          containerName: container?.name ?? td.family,
          port: container?.portMappings?.[0]?.containerPort ?? 0,
          taskRoleArn: td.taskRoleArn,
          executionRoleArn: td.executionRoleArn,
          logGroupName: logGroup.logGroupName,
          logGroupArn: logGroup.logGroupArn,
        };
      };

      const observedTagsOf = Effect.fn(function* (resourceArn: string) {
        const listed = yield* ecs
          .listTagsForResource({ resourceArn })
          .pipe(
            Effect.catchTag("ClientException", () =>
              Effect.succeed({ tags: undefined } as { tags?: ecs.Tag[] }),
            ),
          );
        return Object.fromEntries(
          (listed.tags ?? [])
            .filter(
              (t): t is { key: string; value: string } =>
                typeof t.key === "string" && typeof t.value === "string",
            )
            .map((t) => [t.key, t.value]),
        );
      });

      const listFamilyArns = Effect.fn(function* (
        family: string,
        status: "ACTIVE" | "INACTIVE",
      ) {
        const arns = yield* ecs.listTaskDefinitions
          .pages({ familyPrefix: family, status })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap(
                (page) => page.taskDefinitionArns ?? [],
              ),
            ),
          );
        // familyPrefix is a prefix match — filter to the exact family.
        return arns.filter(
          (arn) => arn.split("/").pop()?.split(":")[0] === family,
        );
      });

      class TaskDefinitionRevisionNotTerminal extends Data.TaggedError(
        "TaskDefinitionRevisionNotTerminal",
      )<{
        readonly taskDefinitionArn: string;
        readonly status: ecs.TaskDefinitionStatus | undefined;
      }> {}

      const deletionObservationSchedule = Schedule.max([
        Schedule.spaced("1 second"),
        Schedule.recurs(15),
      ]);

      const waitUntilRevisionDeregistered = Effect.fn(function* (
        taskDefinitionArn: string,
      ) {
        yield* ecs
          .describeTaskDefinition({ taskDefinition: taskDefinitionArn })
          .pipe(
            Effect.flatMap(({ taskDefinition }) =>
              taskDefinition?.status !== "ACTIVE"
                ? Effect.void
                : Effect.fail(
                    new TaskDefinitionRevisionNotTerminal({
                      taskDefinitionArn,
                      status: taskDefinition.status,
                    }),
                  ),
            ),
            Effect.retry({
              while: (error) =>
                error._tag === "TaskDefinitionRevisionNotTerminal",
              schedule: deletionObservationSchedule,
            }),
            Effect.catchTag("ClientException", () => Effect.void),
          );
      });

      const waitUntilRevisionDeletionStarted = Effect.fn(function* (
        taskDefinitionArn: string,
      ) {
        yield* ecs
          .describeTaskDefinition({ taskDefinition: taskDefinitionArn })
          .pipe(
            Effect.flatMap(({ taskDefinition }) =>
              taskDefinition?.status === "DELETE_IN_PROGRESS"
                ? Effect.void
                : Effect.fail(
                    new TaskDefinitionRevisionNotTerminal({
                      taskDefinitionArn,
                      status: taskDefinition?.status,
                    }),
                  ),
            ),
            Effect.retry({
              while: (error) =>
                error._tag === "TaskDefinitionRevisionNotTerminal",
              schedule: deletionObservationSchedule,
            }),
            // ECS eventually removes an unreferenced DELETE_IN_PROGRESS
            // revision. Not-found is therefore also a successful terminal
            // observation; literal absence is not required because referenced
            // revisions may legitimately remain DELETE_IN_PROGRESS.
            Effect.catchTag("ClientException", () => Effect.void),
          );
      });

      return {
        stables: ["family"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toFamily(id, olds ?? {})) !==
            (yield* toFamily(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const family = output?.family ?? (yield* toFamily(id, olds ?? {}));
          const td = yield* describeLatestActive(family);
          if (!td?.taskDefinitionArn) {
            return undefined;
          }
          const attrs = attrsOf(td, {
            logGroupName: output?.logGroupName,
            logGroupArn: output?.logGroupArn,
          });
          if (!attrs) {
            return undefined;
          }
          const tags = yield* observedTagsOf(td.taskDefinitionArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, olds, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const family = yield* toFamily(id, news);
          const desired = desiredRequestOf(family, news, region);
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };

          // Alchemy-managed log group (awslogs convenience). Create the
          // desired group if requested; drop a previously-managed group whose
          // name no longer matches (renamed or awslogs disabled).
          const logGroupName = logGroupNameOf(family, news);
          if (output?.logGroupName && output.logGroupName !== logGroupName) {
            yield* logs
              .deleteLogGroup({ logGroupName: output.logGroupName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }
          let logGroup: { logGroupName?: string; logGroupArn?: string } = {};
          if (logGroupName !== undefined) {
            yield* logs
              .createLogGroup({ logGroupName, tags: desiredTags })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsException",
                  () => Effect.void,
                ),
              );
            logGroup = {
              logGroupName,
              logGroupArn: `arn:aws:logs:${region}:${accountId}:log-group:${logGroupName}`,
            };
          }

          // Observe — the latest ACTIVE revision of the family is the
          // authoritative current state (output is only an identity cache).
          const observed = yield* describeLatestActive(family);

          // A new revision is needed when the observed revision drifted from
          // the desired definition, or when a prop was *removed* relative to
          // the previous desired state (removal falls back to an AWS default
          // that the projection comparison intentionally ignores).
          const removedProps =
            olds !== undefined &&
            !deepEqual(
              canonicalize(desiredRequestOf(family, olds, region)),
              canonicalize(desired),
            );
          const upToDate =
            observed !== undefined &&
            !removedProps &&
            matchesObserved(desired, observed);

          if (upToDate) {
            // No-op redeploy — reuse the observed revision; converge tags.
            const revisionArn = observed.taskDefinitionArn!;
            const observedTags = yield* observedTagsOf(revisionArn);
            const { removed, upsert } = diffTags(observedTags, desiredTags);
            if (upsert.length > 0) {
              yield* ecs.tagResource({
                resourceArn: revisionArn,
                tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
              });
            }
            if (removed.length > 0) {
              yield* ecs.untagResource({
                resourceArn: revisionArn,
                tagKeys: removed,
              });
            }
            yield* session.note(revisionArn);
            return attrsOf(observed, logGroup)!;
          }

          // Register a new immutable revision. Prior revisions stay ACTIVE
          // (running tasks/services keep working) and are deregistered when
          // the resource is deleted.
          const registered = yield* ecs.registerTaskDefinition({
            ...desired,
            tags: Object.entries(desiredTags).map(([key, value]) => ({
              key,
              value,
            })),
          });
          const td = registered.taskDefinition;
          const attrs = td && attrsOf(td, logGroup);
          if (!attrs) {
            return yield* Effect.die(
              new Error("registerTaskDefinition returned no task definition"),
            );
          }
          yield* session.note(attrs.taskDefinitionArn);
          return attrs;
        }),
        // Enumerate the latest ACTIVE revision of every task definition
        // family in the account/region.
        list: () =>
          Effect.gen(function* () {
            const arns = yield* ecs.listTaskDefinitions
              .pages({ status: "ACTIVE" })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap(
                    (page) => page.taskDefinitionArns ?? [],
                  ),
                ),
              );
            const latest = new Map<string, { arn: string; revision: number }>();
            for (const arn of arns) {
              const suffix = arn.split("/").pop();
              if (!suffix) continue;
              const sep = suffix.lastIndexOf(":");
              const family = suffix.slice(0, sep);
              const revision = Number(suffix.slice(sep + 1));
              const current = latest.get(family);
              if (!current || revision > current.revision) {
                latest.set(family, { arn, revision });
              }
            }
            const rows = yield* Effect.forEach(
              [...latest.values()],
              ({ arn }) =>
                ecs.describeTaskDefinition({ taskDefinition: arn }).pipe(
                  Effect.map((described) =>
                    described.taskDefinition
                      ? attrsOf(described.taskDefinition)
                      : undefined,
                  ),
                  Effect.catchTag("ClientException", () =>
                    Effect.succeed(undefined),
                  ),
                ),
              { concurrency: 10 },
            );
            return rows.filter(
              (row): row is TaskDefinition["Attributes"] => row !== undefined,
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          // Deregister every ACTIVE revision of the family (the family is
          // this resource's physical identity), tolerating already-INACTIVE
          // races, then hard-delete all revisions. AWS can retain a referenced
          // revision in DELETE_IN_PROGRESS, so observe that exact terminal
          // status rather than waiting indefinitely for physical absence.
          const active = yield* listFamilyArns(output.family, "ACTIVE").pipe(
            Effect.catchTag("ClientException", () =>
              Effect.succeed([] as string[]),
            ),
          );
          const alreadyInactive = yield* listFamilyArns(
            output.family,
            "INACTIVE",
          ).pipe(
            Effect.catchTag("ClientException", () =>
              Effect.succeed([] as string[]),
            ),
          );
          for (const arn of active) {
            yield* ecs
              .deregisterTaskDefinition({ taskDefinition: arn })
              .pipe(
                Effect.catchTag(
                  ["ClientException", "InvalidParameterException"],
                  () => Effect.void,
                ),
              );
          }
          yield* Effect.forEach(active, waitUntilRevisionDeregistered, {
            concurrency: 10,
          });
          const inactive = [
            ...new Set([
              ...active,
              ...alreadyInactive,
              ...(yield* listFamilyArns(output.family, "INACTIVE").pipe(
                Effect.catchTag("ClientException", () =>
                  Effect.succeed([] as string[]),
                ),
              )),
            ]),
          ];
          for (let i = 0; i < inactive.length; i += 10) {
            const deleted = yield* ecs
              .deleteTaskDefinitions({
                taskDefinitions: inactive.slice(i, i + 10),
              })
              .pipe(
                Effect.catchTag(
                  ["ClientException", "InvalidParameterException"],
                  () => Effect.void,
                ),
              );
            if (deleted && (deleted.failures?.length ?? 0) > 0) {
              return yield* Effect.die(
                new Error(
                  `ECS failed to delete task definition revisions: ${deleted.failures
                    ?.map(
                      (failure) =>
                        `${failure.arn ?? "unknown"}: ${failure.reason ?? "unknown"} (${failure.detail ?? "no detail"})`,
                    )
                    .join(", ")}`,
                ),
              );
            }
          }
          yield* Effect.forEach(inactive, waitUntilRevisionDeletionStarted, {
            concurrency: 10,
          });
          if (output.logGroupName) {
            yield* logs
              .deleteLogGroup({ logGroupName: output.logGroupName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              );
          }
        }),
      };
    }),
  );
