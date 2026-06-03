import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
   * Estimated warmup time for new instances.
   */
  estimatedInstanceWarmup?: number;
}

export interface ScalingPolicy extends Resource<
  "AWS.AutoScaling.ScalingPolicy",
  ScalingPolicyProps,
  {
    policyArn: string;
    policyName: ScalingPolicyName;
    autoScalingGroupName: string;
    policyType: string;
    targetValue: number;
    predefinedMetricType: string;
    alarms: string[];
  },
  never,
  Providers
> {}

/**
 * A target-tracking scaling policy for an Auto Scaling Group.
 */
export const ScalingPolicy = Resource<ScalingPolicy>(
  "AWS.AutoScaling.ScalingPolicy",
);

const isAutoScalingGroupResource = (
  value: unknown,
): value is AutoScalingGroupResource =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as { Type?: string }).Type === "AWS.AutoScaling.AutoScalingGroup";

export const ScalingPolicyProvider = () =>
  Provider.effect(
    ScalingPolicy,
    Effect.gen(function* () {
      const toName = (id: string, props: { policyName?: string } = {}) =>
        props.policyName
          ? Effect.succeed(props.policyName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const toAutoScalingGroupName = (
        input: ScalingPolicyProps["autoScalingGroup"],
      ) =>
        isAutoScalingGroupResource(input)
          ? (input.autoScalingGroupName as unknown as string)
          : (input as unknown as string);

      const describePolicy = ({
        autoScalingGroupName,
        policyName,
      }: {
        autoScalingGroupName: string;
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
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          if (
            oldName !== newName ||
            toAutoScalingGroupName(olds.autoScalingGroup) !==
              toAutoScalingGroupName(news.autoScalingGroup)
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
            toAutoScalingGroupName(olds!.autoScalingGroup);
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
            EstimatedInstanceWarmup: news.estimatedInstanceWarmup,
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
