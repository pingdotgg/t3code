import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import * as cloudwatch from "@distilled.cloud/aws/cloudwatch";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { SERVICE_NAMESPACES, retryWhileTargetPropagates } from "./internal.ts";

export interface ScalingPolicyProps {
  /**
   * Policy name. If omitted, a deterministic name is generated.
   *
   * Changing this triggers a replacement.
   */
  policyName?: string;
  /**
   * The namespace of the AWS service that provides the scalable target,
   * e.g. `ecs`, `dynamodb`.
   *
   * Changing this triggers a replacement.
   */
  serviceNamespace: aas.ServiceNamespace;
  /**
   * The identifier of the resource the policy's scalable target scales,
   * e.g. `service/{clusterName}/{serviceName}` or `table/{tableName}`.
   *
   * Changing this triggers a replacement.
   */
  resourceId: string;
  /**
   * The scalable dimension of the scalable target,
   * e.g. `ecs:service:DesiredCount` or `dynamodb:table:ReadCapacityUnits`.
   *
   * Changing this triggers a replacement.
   */
  scalableDimension: aas.ScalableDimension;
  /**
   * Target tracking configuration — track a predefined metric
   * (e.g. `ECSServiceAverageCPUUtilization`) or a customized CloudWatch
   * metric specification against a target value.
   *
   * Exactly one of `targetTracking` or `stepScaling` must be provided.
   */
  targetTracking?: aas.TargetTrackingScalingPolicyConfiguration;
  /**
   * Step scaling configuration — apply step adjustments in response to a
   * CloudWatch alarm you manage.
   *
   * Exactly one of `targetTracking` or `stepScaling` must be provided.
   */
  stepScaling?: aas.StepScalingPolicyConfiguration;
}

export interface ScalingPolicy extends Resource<
  "AWS.ApplicationAutoScaling.ScalingPolicy",
  ScalingPolicyProps,
  {
    /**
     * Name of the scaling policy.
     */
    policyName: string;
    /**
     * ARN of the scaling policy.
     */
    policyArn: string;
    /**
     * Namespace of the AWS service that provides the scalable target.
     */
    serviceNamespace: aas.ServiceNamespace;
    /**
     * Identifier of the scaled resource.
     */
    resourceId: string;
    /**
     * Scalable dimension the policy applies to.
     */
    scalableDimension: aas.ScalableDimension;
    /**
     * Policy type (`TargetTrackingScaling` or `StepScaling`).
     */
    policyType: aas.PolicyType;
    /**
     * CloudWatch alarms created and managed by Application Auto Scaling for
     * a target tracking policy.
     */
    alarms: { alarmName: string; alarmArn: string }[];
  },
  never,
  Providers
> {}

/**
 * An Application Auto Scaling scaling policy attached to a scalable target.
 *
 * Supports `TargetTrackingScaling` (Application Auto Scaling creates and
 * manages the CloudWatch alarms) and `StepScaling` (you attach the policy to
 * your own alarm). The policy applies to the scalable target identified by
 * the (`serviceNamespace`, `resourceId`, `scalableDimension`) triple, which
 * must be registered (see {@link ScalableTarget}) before the policy is
 * created — pass the target's outputs so deployment orders correctly.
 * @resource
 * @section Target Tracking
 * @example Track ECS Service CPU
 * ```typescript
 * const target = yield* ScalableTarget("ApiScaling", {
 *   serviceNamespace: "ecs",
 *   resourceId: Output.interpolate`service/${cluster.clusterName}/${service.serviceName}`,
 *   scalableDimension: "ecs:service:DesiredCount",
 *   minCapacity: 1,
 *   maxCapacity: 3,
 * });
 *
 * yield* ScalingPolicy("ApiCpuPolicy", {
 *   serviceNamespace: target.serviceNamespace,
 *   resourceId: target.resourceId,
 *   scalableDimension: target.scalableDimension,
 *   targetTracking: {
 *     TargetValue: 60,
 *     PredefinedMetricSpecification: {
 *       PredefinedMetricType: "ECSServiceAverageCPUUtilization",
 *     },
 *     ScaleOutCooldown: 60,
 *     ScaleInCooldown: 60,
 *   },
 * });
 * ```
 *
 * @example Track a Customized Metric
 * ```typescript
 * yield* ScalingPolicy("QueueDepthPolicy", {
 *   serviceNamespace: target.serviceNamespace,
 *   resourceId: target.resourceId,
 *   scalableDimension: target.scalableDimension,
 *   targetTracking: {
 *     TargetValue: 100,
 *     CustomizedMetricSpecification: {
 *       MetricName: "ApproximateNumberOfMessagesVisible",
 *       Namespace: "AWS/SQS",
 *       Dimensions: [{ Name: "QueueName", Value: "my-queue" }],
 *       Statistic: "Average",
 *     },
 *   },
 * });
 * ```
 *
 * @section Step Scaling
 * @example Step Adjustments
 * ```typescript
 * yield* ScalingPolicy("ApiStepPolicy", {
 *   serviceNamespace: target.serviceNamespace,
 *   resourceId: target.resourceId,
 *   scalableDimension: target.scalableDimension,
 *   stepScaling: {
 *     AdjustmentType: "ChangeInCapacity",
 *     Cooldown: 60,
 *     MetricAggregationType: "Average",
 *     StepAdjustments: [
 *       { MetricIntervalLowerBound: 0, ScalingAdjustment: 1 },
 *     ],
 *   },
 * });
 * ```
 */
export const ScalingPolicy = Resource<ScalingPolicy>(
  "AWS.ApplicationAutoScaling.ScalingPolicy",
);

/**
 * Raised before any AWS call when a `ScalingPolicy` declares both or neither
 * of `targetTracking` / `stepScaling` — the two configurations are mutually
 * exclusive and exactly one is required.
 */
export class ScalingPolicyConfigurationConflict extends Data.TaggedError(
  "ScalingPolicyConfigurationConflict",
)<{ message: string }> {}

const validateConfiguration = (props: {
  targetTracking?: aas.TargetTrackingScalingPolicyConfiguration;
  stepScaling?: aas.StepScalingPolicyConfiguration;
}) =>
  (props.targetTracking === undefined) === (props.stepScaling === undefined)
    ? Effect.fail(
        new ScalingPolicyConfigurationConflict({
          message:
            "Exactly one of targetTracking or stepScaling must be provided.",
        }),
      )
    : Effect.void;

export const ScalingPolicyProvider = () =>
  Provider.effect(
    ScalingPolicy,
    Effect.gen(function* () {
      const toName = (id: string, props: { policyName?: string } = {}) =>
        props.policyName
          ? Effect.succeed(props.policyName)
          : createPhysicalName({ id, maxLength: 255 });

      const describe = (props: {
        serviceNamespace: aas.ServiceNamespace;
        policyName: string;
        resourceId?: string;
        scalableDimension?: aas.ScalableDimension;
      }) =>
        aas
          .describeScalingPolicies({
            ServiceNamespace: props.serviceNamespace,
            PolicyNames: [props.policyName],
            ResourceId: props.resourceId,
            ScalableDimension: props.scalableDimension,
          })
          .pipe(
            Effect.map((res) =>
              res.ScalingPolicies?.find(
                (p) => p.PolicyName === props.policyName,
              ),
            ),
          );

      const toAttributes = (
        policy: aas.ScalingPolicy,
      ): ScalingPolicy["Attributes"] => ({
        policyName: policy.PolicyName,
        policyArn: policy.PolicyARN,
        serviceNamespace: policy.ServiceNamespace,
        resourceId: policy.ResourceId,
        scalableDimension: policy.ScalableDimension,
        policyType: policy.PolicyType,
        alarms: (policy.Alarms ?? []).map((alarm) => ({
          alarmName: alarm.AlarmName,
          alarmArn: alarm.AlarmARN,
        })),
      });

      return {
        stables: [
          "policyName",
          "policyArn",
          "serviceNamespace",
          "resourceId",
          "scalableDimension",
        ],

        // Account/region-wide enumeration; the describe API requires a
        // `ServiceNamespace` filter, so union the per-namespace pages.
        list: () =>
          Effect.forEach(
            SERVICE_NAMESPACES,
            (namespace) =>
              aas.describeScalingPolicies
                .pages({ ServiceNamespace: namespace })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) =>
                      (page.ScalingPolicies ?? []).map(toAttributes),
                    ),
                  ),
                ),
            { concurrency: 4 },
          ).pipe(Effect.map((groups) => groups.flat())),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // The target triple pins the policy to a scalable target — any
          // change replaces the policy. Only compare sides that are known:
          // a half-created state row may have lost Output-valued props.
          for (const key of [
            "serviceNamespace",
            "resourceId",
            "scalableDimension",
          ] as const) {
            const oldValue = olds?.[key];
            if (
              oldValue !== undefined &&
              isResolved(oldValue) &&
              oldValue !== news[key]
            ) {
              return { action: "replace" } as const;
            }
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const serviceNamespace =
            output?.serviceNamespace ?? olds?.serviceNamespace;
          if (serviceNamespace === undefined) return undefined;
          const policyName =
            output?.policyName ?? (yield* toName(id, olds ?? {}));
          const policy = yield* describe({
            serviceNamespace,
            policyName,
            resourceId: output?.resourceId ?? olds?.resourceId,
            scalableDimension:
              output?.scalableDimension ?? olds?.scalableDimension,
          });
          return policy ? toAttributes(policy) : undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          yield* validateConfiguration(news);
          const policyName = yield* toName(id, news);
          const policyType: aas.PolicyType = news.targetTracking
            ? "TargetTrackingScaling"
            : "StepScaling";

          // Ensure + sync — `putScalingPolicy` is the single
          // create-or-update API, keyed by (name, target triple); it
          // overwrites the policy configuration on every call, so one
          // unconditional put converges any starting state. A put issued
          // immediately after the target registers can race its
          // propagation — retry the typed ObjectNotFoundException briefly.
          yield* retryWhileTargetPropagates(
            aas.putScalingPolicy({
              PolicyName: policyName,
              ServiceNamespace: news.serviceNamespace,
              ResourceId: news.resourceId,
              ScalableDimension: news.scalableDimension,
              PolicyType: policyType,
              TargetTrackingScalingPolicyConfiguration: news.targetTracking,
              StepScalingPolicyConfiguration: news.stepScaling,
            }),
          );

          // Observe final state so attributes carry the generated ARN and
          // the CloudWatch alarms Application Auto Scaling manages.
          const policy = yield* describe({
            serviceNamespace: news.serviceNamespace,
            policyName,
            resourceId: news.resourceId,
            scalableDimension: news.scalableDimension,
          });
          if (policy === undefined) {
            return yield* Effect.fail(
              new aas.ObjectNotFoundException({
                Message: `Scaling policy '${policyName}' was not readable after PutScalingPolicy`,
              }),
            );
          }

          yield* session.note(policy.PolicyARN);
          return toAttributes(policy);
        }),

        // Deleting the parent scalable target implicitly deletes its
        // policies, so a policy that is already gone (typed
        // `ObjectNotFoundException`) is success.
        delete: Effect.fn(function* ({ output }) {
          yield* aas
            .deleteScalingPolicy({
              PolicyName: output.policyName,
              ServiceNamespace: output.serviceNamespace,
              ResourceId: output.resourceId,
              ScalableDimension: output.scalableDimension,
            })
            .pipe(
              Effect.catchTag("ObjectNotFoundException", () => Effect.void),
            );
          // Reap the managed CloudWatch alarms of a target tracking policy.
          // Application Auto Scaling deletes them asynchronously (and not at
          // all when the policy went away via target deregistration), so an
          // explicit delete keeps teardown deterministic. DeleteAlarms
          // ignores names that no longer exist.
          if (output.alarms.length > 0) {
            yield* cloudwatch
              .deleteAlarms({
                AlarmNames: output.alarms.map((alarm) => alarm.alarmName),
              })
              .pipe(Effect.catchTag("ResourceNotFound", () => Effect.void));
          }
        }),
      };
    }),
  );
