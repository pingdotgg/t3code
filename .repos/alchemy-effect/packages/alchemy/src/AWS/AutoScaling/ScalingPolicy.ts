import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import type { AutoScalingGroup as AutoScalingGroupResource } from "./AutoScalingGroup.ts";

export type ScalingPolicyName = string;

export interface ScalingPolicyProps {
  /**
   * Policy name. If omitted, a deterministic name is generated.
   */
  policyName?: string;
  /**
   * Auto Scaling Group to attach the policy to.
   */
  autoScalingGroup: Input<string> | AutoScalingGroupResource;
  /**
   * Policy type.
   * @default "TargetTrackingScaling"
   */
  policyType?: "TargetTrackingScaling";
  /**
   * Predefined scaling metric to track.
   */
  predefinedMetricType:
    | "ASGAverageCPUUtilization"
    | "ASGAverageNetworkIn"
    | "ASGAverageNetworkOut"
    | "ALBRequestCountPerTarget";
  /**
   * Desired target value for the metric.
   */
  targetValue: number;
  /**
   * Disable scale-in while target tracking is active.
   */
  disableScaleIn?: boolean;
  /**
   * Estimated warmup time for new instances, e.g. `"5 minutes"` or
   * `Duration.seconds(300)` (whole seconds on the wire).
   */
  estimatedInstanceWarmup?: Duration.Input;
}

export interface ScalingPolicy extends Resource<
  "AWS.AutoScaling.ScalingPolicy",
  ScalingPolicyProps,
  {
    /**
     * ARN of the scaling policy.
     */
    policyArn: string;
    /**
     * Name of the scaling policy.
     */
    policyName: ScalingPolicyName;
    /**
     * Name of the Auto Scaling Group the policy is attached to.
     */
    autoScalingGroupName: string;
    /**
     * Policy type (e.g. `TargetTrackingScaling`).
     */
    policyType: string;
    /**
     * Target value the tracked metric is held at.
     */
    targetValue: number;
    /**
     * Predefined metric being tracked.
     */
    predefinedMetricType: string;
    /**
     * CloudWatch alarms created by EC2 Auto Scaling to drive the policy.
     */
    alarms: string[];
  },
  never,
  Providers
> {}

/**
 * A target-tracking scaling policy for an Auto Scaling Group. EC2 Auto
 * Scaling creates and manages the CloudWatch alarms that keep the tracked
 * metric at `targetValue` by adjusting the group's desired capacity.
 * @resource
 * @section Creating a Scaling Policy
 * @example Track average CPU utilization
 * ```typescript
 * import { AutoScalingGroup, ScalingPolicy } from "alchemy/AWS/AutoScaling";
 *
 * const group = yield* AutoScalingGroup("Fleet", {
 *   launchTemplate: template,
 *   subnetIds: [subnet.subnetId],
 *   minSize: 1,
 *   maxSize: 4,
 * });
 *
 * const policy = yield* ScalingPolicy("CpuPolicy", {
 *   autoScalingGroup: group,
 *   predefinedMetricType: "ASGAverageCPUUtilization",
 *   targetValue: 60,
 * });
 * ```
 *
 * @example Scale on ALB requests per target without scale-in
 * ```typescript
 * const policy = yield* ScalingPolicy("RequestPolicy", {
 *   autoScalingGroup: group,
 *   predefinedMetricType: "ALBRequestCountPerTarget",
 *   targetValue: 1000,
 *   disableScaleIn: true,
 *   estimatedInstanceWarmup: "3 minutes",
 * });
 * ```
 */
export const ScalingPolicy = Resource<ScalingPolicy>(
  "AWS.AutoScaling.ScalingPolicy",
);

export const ScalingPolicyProvider = () =>
  Provider.effect(
    ScalingPolicy,
    Effect.gen(function* () {
      const toName = (id: string, props: { policyName?: string } = {}) =>
        props.policyName
          ? Effect.succeed(props.policyName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      // Derive the group name from either spelling of `autoScalingGroup`. A
      // whole AutoScalingGroup resource resolves to its bare Attributes
      // before reaching the provider — the resource `Type` marker does not
      // survive resolution — so narrow on the attributes shape, never on
      // `Type`. May also receive `undefined`: an Output-valued
      // `autoScalingGroup` doesn't survive a `creating`-state round-trip
      // (it deserializes as `undefined`), and recovery paths hand those
      // props back as `olds`.
      const toAutoScalingGroupName = (
        input: ScalingPolicyProps["autoScalingGroup"] | undefined,
      ): string | undefined =>
        typeof input === "string"
          ? input
          : typeof (input as { autoScalingGroupName?: unknown } | undefined)
                ?.autoScalingGroupName === "string"
            ? (input as unknown as { autoScalingGroupName: string })
                .autoScalingGroupName
            : undefined;

      // `describePolicies` searches account-wide when no AutoScalingGroupName
      // is given; policy names are unique physical names, so a name-only
      // lookup still identifies our policy during state recovery.
      const describePolicy = ({
        autoScalingGroupName,
        policyName,
      }: {
        autoScalingGroupName: string | undefined;
        policyName: string;
      }) =>
        autoscaling
          .describePolicies({
            AutoScalingGroupName: autoScalingGroupName,
            PolicyNames: [policyName],
          })
          .pipe(Effect.map((result) => result.ScalingPolicies?.[0]));

      const toAttributes = (
        policy: autoscaling.ScalingPolicy,
      ): ScalingPolicy["Attributes"] => ({
        policyArn: policy.PolicyARN!,
        policyName: policy.PolicyName!,
        autoScalingGroupName: policy.AutoScalingGroupName!,
        policyType: policy.PolicyType!,
        targetValue:
          policy.TargetTrackingConfiguration?.TargetValue ??
          policy.StepAdjustments?.[0]?.MetricIntervalLowerBound ??
          0,
        predefinedMetricType:
          policy.TargetTrackingConfiguration?.PredefinedMetricSpecification
            ?.PredefinedMetricType ?? "",
        alarms: (policy.Alarms ?? [])
          .map((alarm) => alarm.AlarmName)
          .filter((alarm): alarm is string => Boolean(alarm)),
      });

      return {
        stables: ["policyArn", "policyName", "autoScalingGroupName"],
        // `describePolicies` enumerates every scaling policy across all Auto
        // Scaling Groups in the account/region when no AutoScalingGroupName
        // filter is supplied, so no parent enumeration is needed.
        list: () =>
          autoscaling.describePolicies.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ScalingPolicies ?? []).map(toAttributes),
              ),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          // ASG change → replace, but only when both sides are known — a
          // half-created state row may have lost an Output-valued
          // `autoScalingGroup`, and an unknown old ASG must fall through to
          // the create/update recovery path rather than force a replacement.
          const oldGroupName = toAutoScalingGroupName(olds.autoScalingGroup);
          const newGroupName = toAutoScalingGroupName(news.autoScalingGroup);
          if (
            oldName !== newName ||
            (oldGroupName !== undefined &&
              newGroupName !== undefined &&
              oldGroupName !== newGroupName)
          ) {
            return { action: "replace" } as const;
          }

          if (!deepEqual(olds, news)) {
            return {
              action: "update",
              stables: ["policyArn", "policyName", "autoScalingGroupName"],
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const autoScalingGroupName =
            output?.autoScalingGroupName ??
            toAutoScalingGroupName(olds?.autoScalingGroup);
          const policyName =
            output?.policyName ?? (yield* toName(id, olds ?? {}));
          const policy = yield* describePolicy({
            autoScalingGroupName,
            policyName,
          });
          return policy ? toAttributes(policy) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const autoScalingGroupName =
            output?.autoScalingGroupName ??
            toAutoScalingGroupName(news.autoScalingGroup);
          const policyName = output?.policyName ?? (yield* toName(id, news));

          // Ensure + Sync — `putScalingPolicy` is the single
          // create-or-update API for a scaling policy. It's idempotent on
          // matching params and overwrites policy type / target tracking
          // config / estimated warmup on differences, so we issue it
          // unconditionally.
          yield* autoscaling.putScalingPolicy({
            AutoScalingGroupName: autoScalingGroupName,
            PolicyName: policyName,
            PolicyType: news.policyType ?? "TargetTrackingScaling",
            TargetTrackingConfiguration: {
              PredefinedMetricSpecification: {
                PredefinedMetricType: news.predefinedMetricType,
              },
              TargetValue: news.targetValue,
              DisableScaleIn: news.disableScaleIn,
            },
            EstimatedInstanceWarmup: toSeconds(news.estimatedInstanceWarmup),
          } as any);

          // Observe final state — re-read so the returned attributes
          // reflect the live cloud state (including the generated
          // policyArn and any associated alarm names).
          const policy = yield* describePolicy({
            autoScalingGroupName,
            policyName,
          }).pipe(
            Effect.flatMap((policy) =>
              policy
                ? Effect.succeed(policy)
                : Effect.fail(
                    new Error(
                      `Scaling policy '${policyName}' was not readable after reconcile`,
                    ),
                  ),
            ),
          );
          yield* session.note(policyName);
          return toAttributes(policy);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* autoscaling.deletePolicy({
            AutoScalingGroupName: output.autoScalingGroupName,
            PolicyName: output.policyName,
          } as any);
        }),
      };
    }),
  );
