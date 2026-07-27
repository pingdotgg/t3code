import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  tagRecord,
} from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import {
  retryOnConflict,
  waitUntilAbsent,
  waitUntilStable,
} from "./internal.ts";

/**
 * The kind of compute a target group routes to.
 */
export type TargetGroupType = "IP" | "LAMBDA" | "INSTANCE" | "ALB";

/**
 * A target registered with a target group: an IP address, EC2 instance ID,
 * ALB ARN, or Lambda function ARN depending on the group's `type`.
 */
export interface TargetGroupTarget {
  /**
   * The target identifier: IP address (`IP`), instance ID (`INSTANCE`),
   * load balancer ARN (`ALB`), or Lambda function ARN (`LAMBDA`).
   */
  id: string;
  /**
   * Port the target listens on. Not applicable to `LAMBDA` targets.
   */
  port?: number;
}

/**
 * Health check configuration for `IP` and `INSTANCE` target groups.
 */
export interface TargetGroupHealthCheck {
  /**
   * Whether health checking is enabled.
   */
  enabled?: boolean;
  /**
   * Protocol used for health check requests (`HTTP` or `HTTPS`).
   */
  protocol?: string;
  /**
   * Protocol version used for health check requests (`HTTP1` or `HTTP2`).
   */
  protocolVersion?: string;
  /**
   * Port used for health checks. Defaults to the target's port.
   */
  port?: number;
  /**
   * Destination path for health check requests.
   * @default "/"
   */
  path?: string;
  /**
   * Approximate time between health checks of an individual target, e.g.
   * `"30 seconds"` (a bare number is milliseconds). Rounded to whole seconds
   * on the wire.
   */
  healthCheckInterval?: Duration.Input;
  /**
   * Time to wait before a health check request is considered failed, e.g.
   * `"5 seconds"` (a bare number is milliseconds). Rounded to whole seconds
   * on the wire.
   */
  healthCheckTimeout?: Duration.Input;
  /**
   * Consecutive successful checks required before an unhealthy target is
   * considered healthy.
   */
  healthyThresholdCount?: number;
  /**
   * Consecutive failed checks required before a healthy target is considered
   * unhealthy.
   */
  unhealthyThresholdCount?: number;
  /**
   * HTTP status codes counted as a healthy response, e.g. `{ httpCode: "200-299" }`.
   */
  matcher?: { httpCode: string };
}

export interface TargetGroupProps {
  /**
   * Name of the target group. If omitted, a unique name is generated.
   * Immutable — changing it replaces the resource.
   */
  name?: string;
  /**
   * The kind of targets the group routes to. Immutable — changing it replaces
   * the resource.
   */
  type: TargetGroupType;
  /**
   * Port the targets listen on. Required for every type except `LAMBDA`.
   * Immutable — changing it replaces the resource.
   */
  port?: number;
  /**
   * Protocol used to route traffic to the targets (`HTTP`, `HTTPS`, or
   * `TCP`). Not applicable to `LAMBDA`. Immutable — changing it replaces the
   * resource.
   */
  protocol?: string;
  /**
   * Protocol version (`HTTP1`, `HTTP2`, or `GRPC`). Not applicable to
   * `LAMBDA`. Immutable — changing it replaces the resource.
   * @default "HTTP1"
   */
  protocolVersion?: string;
  /**
   * IP address type of the targets (`IPV4` or `IPV6`). `IP` type only.
   * Immutable — changing it replaces the resource.
   * @default "IPV4"
   */
  ipAddressType?: string;
  /**
   * ID of the VPC the targets live in. Required for every type except
   * `LAMBDA`. Immutable — changing it replaces the resource.
   */
  vpcIdentifier?: string;
  /**
   * Version of the event structure a `LAMBDA` target receives (`V1` or
   * `V2`). Immutable — changing it replaces the resource.
   * @default "V1"
   */
  lambdaEventStructureVersion?: string;
  /**
   * Health check configuration. Mutable for `IP` and `INSTANCE` groups; not
   * applicable to `LAMBDA` and `ALB`.
   */
  healthCheck?: TargetGroupHealthCheck;
  /**
   * Targets to keep registered with the group. Reconciled against the
   * observed registrations: missing targets are registered and extra ones
   * are deregistered.
   */
  targets?: TargetGroupTarget[];
  /**
   * User-defined tags to apply to the target group.
   */
  tags?: Record<string, string>;
}

export interface TargetGroup extends Resource<
  "AWS.VpcLattice.TargetGroup",
  TargetGroupProps,
  {
    /**
     * Service-assigned unique ID of the target group.
     */
    targetGroupId: string;
    /**
     * ARN of the target group.
     */
    targetGroupArn: string;
    /**
     * Physical name of the target group.
     */
    name: string;
    /**
     * The kind of targets the group routes to.
     */
    type: TargetGroupType;
    /**
     * Current lifecycle status (e.g. `ACTIVE`).
     */
    status: string;
    /**
     * Current tags reported for the target group.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon VPC Lattice target group — the collection of compute targets
 * (IPs, EC2 instances, ALBs, or Lambda functions) that a lattice service's
 * listeners and rules forward traffic to.
 *
 * @resource
 * @section Creating Target Groups
 * @example Lambda Target Group
 * ```typescript
 * const targets = yield* TargetGroup("ApiTargets", {
 *   type: "LAMBDA",
 *   targets: [{ id: fn.functionArn }],
 * });
 * ```
 *
 * @example IP Target Group with Health Check
 * ```typescript
 * const targets = yield* TargetGroup("BackendTargets", {
 *   type: "IP",
 *   port: 80,
 *   protocol: "HTTP",
 *   vpcIdentifier: vpc.vpcId,
 *   healthCheck: {
 *     enabled: true,
 *     path: "/health",
 *     healthCheckInterval: "30 seconds",
 *     healthCheckTimeout: "5 seconds",
 *   },
 *   targets: [{ id: "10.0.1.10", port: 80 }],
 * });
 * ```
 */
export const TargetGroup = Resource<TargetGroup>("AWS.VpcLattice.TargetGroup");

const toWireHealthCheck = (
  healthCheck: TargetGroupHealthCheck,
): vpclattice.HealthCheckConfig => ({
  enabled: healthCheck.enabled,
  protocol: healthCheck.protocol,
  protocolVersion: healthCheck.protocolVersion,
  port: healthCheck.port,
  path: healthCheck.path,
  healthCheckIntervalSeconds: toWireSeconds(healthCheck.healthCheckInterval),
  healthCheckTimeoutSeconds: toWireSeconds(healthCheck.healthCheckTimeout),
  healthyThresholdCount: healthCheck.healthyThresholdCount,
  unhealthyThresholdCount: healthCheck.unhealthyThresholdCount,
  matcher: healthCheck.matcher,
});

const targetKey = (t: { id?: string; port?: number }) =>
  `${t.id ?? ""}#${t.port ?? ""}`;

/**
 * RegisterTargets reports per-target failures in `unsuccessful` instead of
 * throwing. Tagged so callers (e.g. `delete`'s not-found tolerance) can keep
 * using `Effect.catchTag` on the fully typed error union.
 */
class TargetRegistrationFailed extends Data.TaggedError(
  "AWS.VpcLattice.TargetRegistrationFailed",
)<{
  targetGroupId: string;
  unsuccessful: vpclattice.TargetFailure[];
}> {
  override get message() {
    return `Failed to register targets with target group ${this.targetGroupId}: ${JSON.stringify(this.unsuccessful)}`;
  }
}

export const TargetGroupProvider = () =>
  Provider.effect(
    TargetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: { name?: string } = {}) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 63, lowercase: true });

      const observe = (targetGroupIdentifier: string) =>
        vpclattice
          .getTargetGroup({ targetGroupIdentifier })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );

      const findByName = (name: string) =>
        vpclattice.listTargetGroups.pages({}).pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk)
              .flatMap((page) => page.items ?? [])
              .find((t) => t.name === name),
          ),
          Effect.flatMap((summary) =>
            summary?.id ? observe(summary.id) : Effect.succeed(undefined),
          ),
        );

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const listed = yield* vpclattice.listTagsForResource({
          resourceArn: arn,
        });
        const { removed, upsert } = diffTags(
          tagRecord(listed.tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* vpclattice.tagResource({
            resourceArn: arn,
            tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
          });
        }
        if (removed.length > 0) {
          yield* vpclattice.untagResource({
            resourceArn: arn,
            tagKeys: removed,
          });
        }
      });

      const syncTargets = Effect.fn(function* (
        targetGroupId: string,
        desired: TargetGroupTarget[],
      ) {
        const observed = yield* vpclattice.listTargets
          .pages({ targetGroupIdentifier: targetGroupId })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.items ?? []),
            ),
          );
        const desiredKeys = new Set(desired.map(targetKey));
        const observedKeys = new Set(observed.map(targetKey));
        // DRAINING targets are already being deregistered — leave them alone.
        const toRemove = observed.filter(
          (t): t is typeof t & { id: string } =>
            t.id != null &&
            !desiredKeys.has(targetKey(t)) &&
            t.status !== "DRAINING",
        );
        const toAdd = desired.filter((t) => !observedKeys.has(targetKey(t)));
        if (toRemove.length > 0) {
          yield* vpclattice.deregisterTargets({
            targetGroupIdentifier: targetGroupId,
            targets: toRemove.map((t) => ({ id: t.id, port: t.port })),
          });
        }
        if (toAdd.length > 0) {
          // Partial failures are reported in `unsuccessful`, not thrown.
          const result = yield* retryOnConflict(
            vpclattice.registerTargets({
              targetGroupIdentifier: targetGroupId,
              targets: toAdd,
            }),
          );
          const unsuccessful = result.unsuccessful ?? [];
          if (unsuccessful.length > 0) {
            return yield* Effect.fail(
              new TargetRegistrationFailed({ targetGroupId, unsuccessful }),
            );
          }
        }
      });

      return {
        stables: ["targetGroupId", "targetGroupArn", "name", "type"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // Everything except healthCheck, targets, and tags is fixed at
          // creation time.
          if (
            olds?.type !== news.type ||
            (olds?.port ?? undefined) !== news.port ||
            (olds?.protocol ?? undefined) !== news.protocol ||
            (olds?.protocolVersion ?? undefined) !== news.protocolVersion ||
            (olds?.ipAddressType ?? undefined) !== news.ipAddressType ||
            (olds?.vpcIdentifier ?? undefined) !== news.vpcIdentifier ||
            (olds?.lambdaEventStructureVersion ?? undefined) !==
              news.lambdaEventStructureVersion
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const group = output?.targetGroupId
            ? yield* observe(output.targetGroupId)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (!group?.arn || !group.id) return undefined;
          const listed = yield* vpclattice.listTagsForResource({
            resourceArn: group.arn,
          });
          const attrs = {
            targetGroupId: group.id,
            targetGroupArn: group.arn,
            name: group.name!,
            type: (group.type as TargetGroupType) ?? "IP",
            status: group.status ?? "UNKNOWN",
            tags: tagRecord(listed.tags),
          };
          return (yield* hasAlchemyTags(id, listed.tags))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* toName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — prefer the stable id cache, fall back to name lookup.
          let group = output?.targetGroupId
            ? yield* observe(output.targetGroupId)
            : yield* findByName(name);

          // Ensure — create if missing.
          if (!group?.arn || !group.id) {
            const created = yield* vpclattice
              .createTargetGroup({
                name,
                type: news.type,
                config:
                  news.type === "LAMBDA" &&
                  news.lambdaEventStructureVersion === undefined
                    ? undefined
                    : {
                        port: news.port,
                        protocol: news.protocol,
                        protocolVersion: news.protocolVersion,
                        ipAddressType: news.ipAddressType,
                        vpcIdentifier: news.vpcIdentifier,
                        lambdaEventStructureVersion:
                          news.lambdaEventStructureVersion,
                        healthCheck: news.healthCheck
                          ? toWireHealthCheck(news.healthCheck)
                          : undefined,
                      },
              })
              .pipe(
                Effect.catchTag("ConflictException", () => findByName(name)),
              );
            if (!created?.arn || !created.id) {
              return yield* Effect.fail(
                new Error(`Failed to create target group ${name}`),
              );
            }
            group = yield* observe(created.id);
            if (!group?.arn || !group.id) {
              group = { id: created.id, arn: created.arn };
            }
          }
          const targetGroupId = group.id;
          const targetGroupArn = group.arn;
          if (!targetGroupId || !targetGroupArn) {
            return yield* Effect.fail(
              new Error(`Target group ${name} is missing its id/arn`),
            );
          }

          // Target groups reject updates while CREATE_IN_PROGRESS.
          const stable = yield* waitUntilStable(observe(targetGroupId));

          // Sync health check — the only mutable setting (IP/INSTANCE only).
          if (news.healthCheck !== undefined) {
            const desired = toWireHealthCheck(news.healthCheck);
            const observedHealthCheck = stable?.config?.healthCheck ?? {};
            const drifted = (
              Object.entries(desired) as [
                keyof vpclattice.HealthCheckConfig,
                unknown,
              ][]
            ).some(
              ([key, value]) =>
                value !== undefined &&
                JSON.stringify(observedHealthCheck[key]) !==
                  JSON.stringify(value),
            );
            if (drifted) {
              yield* retryOnConflict(
                vpclattice.updateTargetGroup({
                  targetGroupIdentifier: targetGroupId,
                  healthCheck: desired,
                }),
              );
            }
          }

          // Sync targets — register missing, deregister extras.
          yield* syncTargets(targetGroupId, news.targets ?? []);

          yield* syncTags(targetGroupArn, desiredTags);

          const final = yield* observe(targetGroupId);
          yield* session.note(targetGroupArn);
          return {
            targetGroupId,
            targetGroupArn,
            name,
            type: news.type,
            status: final?.status ?? stable?.status ?? "ACTIVE",
            tags: desiredTags,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            const summaries = yield* vpclattice.listTargetGroups.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.items ?? []),
              ),
            );
            return yield* Effect.forEach(
              summaries.filter(
                (s): s is typeof s & { id: string; arn: string } =>
                  s.id != null && s.arn != null,
              ),
              (summary) =>
                Effect.gen(function* () {
                  const listed = yield* vpclattice.listTagsForResource({
                    resourceArn: summary.arn,
                  });
                  return {
                    targetGroupId: summary.id,
                    targetGroupArn: summary.arn,
                    name: summary.name!,
                    type: (summary.type as TargetGroupType) ?? "IP",
                    status: summary.status ?? "UNKNOWN",
                    tags: tagRecord(listed.tags),
                  };
                }),
              { concurrency: 10 },
            );
          }),
        delete: Effect.fn(function* ({ output }) {
          // Deregister any remaining targets first so the group doesn't sit
          // in a draining conflict while deleting.
          yield* syncTargets(output.targetGroupId, []).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Deregistered targets sit in DRAINING for a while and
          // DeleteTargetGroup rejects with `ConflictException: TargetGroup
          // has targets registered with it` until they are gone. Wait
          // (bounded) for the drain to complete.
          yield* Effect.repeat(
            vpclattice
              .listTargets({ targetGroupIdentifier: output.targetGroupId })
              .pipe(
                Effect.map((r) => r.items.length),
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(0),
                ),
              ),
            {
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(15),
              ]),
              until: (remaining): boolean => remaining === 0,
            },
          );
          yield* retryOnConflict(
            vpclattice.deleteTargetGroup({
              targetGroupIdentifier: output.targetGroupId,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
          // Deletion is asynchronous while targets drain; wait until the
          // group is actually gone so dependent VPC deletes don't conflict.
          yield* waitUntilAbsent(observe(output.targetGroupId));
        }),
      };
    }),
  );
