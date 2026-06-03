import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createInternalTags, diffTags } from "../../Tags.ts";
import type { SubnetId } from "../EC2/Subnet.ts";
import type {
  LaunchTemplateId,
  LaunchTemplateName,
  LaunchTemplate as LaunchTemplateResource,
} from "./LaunchTemplate.ts";

export type AutoScalingGroupName = string;

export interface LaunchTemplateReference {
  launchTemplateId?: Input<LaunchTemplateId>;
  launchTemplateName?: Input<LaunchTemplateName>;
  version?: Input<string | number>;
}

export interface AutoScalingGroupProps {
  /**
   * Auto Scaling Group name. If omitted, a deterministic name is generated.
   */
  autoScalingGroupName?: string;
  /**
   * Launch template used for instances in the fleet.
   */
  launchTemplate: Input<LaunchTemplateReference> | LaunchTemplateResource;
  /**
   * Subnets to place the fleet into.
   */
  subnetIds: Input<SubnetId[]>;
  /**
   * Minimum number of instances.
   */
  minSize: number;
  /**
   * Maximum number of instances.
   */
  maxSize: number;
  /**
   * Desired number of instances.
   * @default minSize
   */
  desiredCapacity?: number;
  /**
   * Target groups to attach to the fleet.
   */
  targetGroupArns?: Input<string[]>;
  /**
   * Health check type.
   * @default "ELB" when target groups are present, otherwise "EC2"
   */
  healthCheckType?: "EC2" | "ELB";
  /**
   * Grace period in seconds before health checks start.
   */
  healthCheckGracePeriod?: number;
  /**
   * Default cooldown in seconds.
   */
  defaultCooldown?: number;
  /**
   * Termination policies for scale-in.
   */
  terminationPolicies?: string[];
  /**
   * Tags to apply to the Auto Scaling Group itself.
   */
  tags?: Record<string, string>;
}

export interface AutoScalingGroup extends Resource<
  "AWS.AutoScaling.AutoScalingGroup",
  AutoScalingGroupProps,
  {
    autoScalingGroupArn: string;
    autoScalingGroupName: AutoScalingGroupName;
    launchTemplateId?: string;
    launchTemplateName?: string;
    launchTemplateVersion?: string;
    subnetIds: string[];
    minSize: number;
    maxSize: number;
    desiredCapacity: number;
    targetGroupArns: string[];
    healthCheckType?: string;
    healthCheckGracePeriod?: number;
    defaultCooldown?: number;
    terminationPolicies?: string[];
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An EC2 Auto Scaling Group that manages a fleet of instances from a launch
 * template and can register that fleet with one or more load balancer target
 * groups.
 */
export const AutoScalingGroup = Resource<AutoScalingGroup>(
  "AWS.AutoScaling.AutoScalingGroup",
);

const isLaunchTemplateResource = (
  value: unknown,
): value is LaunchTemplateResource =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as { Type?: string }).Type === "AWS.AutoScaling.LaunchTemplate";

const sortStrings = (values: readonly string[] = []) =>
  [...values].sort((a, b) => a.localeCompare(b));

export const AutoScalingGroupProvider = () =>
  Provider.effect(
    AutoScalingGroup,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: { autoScalingGroupName?: string } = {},
      ) =>
        props.autoScalingGroupName
          ? Effect.succeed(props.autoScalingGroupName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const toLaunchTemplateSpec = (
        input: AutoScalingGroupProps["launchTemplate"],
      ) => {
        const spec = isLaunchTemplateResource(input)
          ? {
              launchTemplateId: input.launchTemplateId,
              launchTemplateName: input.launchTemplateName,
              version: input.defaultVersionNumber,
            }
          : ((input ?? {}) as LaunchTemplateReference);

        return {
          LaunchTemplateId: spec.launchTemplateId as string | undefined,
          LaunchTemplateName: spec.launchTemplateName as string | undefined,
          Version:
            spec.version === undefined ? "$Default" : String(spec.version),
        };
      };

      const describeGroup = (autoScalingGroupName: string) =>
        autoscaling
          .describeAutoScalingGroups({
            AutoScalingGroupNames: [autoScalingGroupName],
          })
          .pipe(Effect.map((result) => result.AutoScalingGroups?.[0]));

      const toTags = (name: string, tags: Record<string, string>) =>
        Object.entries(tags).map(([Key, Value]) => ({
          ResourceId: name,
          ResourceType: "auto-scaling-group",
          Key,
          Value,
          PropagateAtLaunch: false,
        }));

      const syncTargetGroups = Effect.fn(function* ({
        autoScalingGroupName,
        oldTargetGroupArns,
        newTargetGroupArns,
      }: {
        autoScalingGroupName: string;
        oldTargetGroupArns: string[];
        newTargetGroupArns: string[];
      }) {
        const oldSet = new Set(oldTargetGroupArns);
        const newSet = new Set(newTargetGroupArns);

        const detached = oldTargetGroupArns.filter((arn) => !newSet.has(arn));
        const attached = newTargetGroupArns.filter((arn) => !oldSet.has(arn));

        if (detached.length > 0) {
          yield* autoscaling.detachLoadBalancerTargetGroups({
            AutoScalingGroupName: autoScalingGroupName,
            TargetGroupARNs: detached,
          } as any);
        }

        if (attached.length > 0) {
          yield* autoscaling.attachLoadBalancerTargetGroups({
            AutoScalingGroupName: autoScalingGroupName,
            TargetGroupARNs: attached,
          } as any);
        }
      });

      const syncTags = Effect.fn(function* ({
        autoScalingGroupName,
        oldTags,
        newTags,
      }: {
        autoScalingGroupName: string;
        oldTags: Record<string, string>;
        newTags: Record<string, string>;
      }) {
        const { removed, upsert } = diffTags(oldTags, newTags);

        if (removed.length > 0) {
          yield* autoscaling.deleteTags({
            Tags: removed.map((Key) => ({
              ResourceId: autoScalingGroupName,
              ResourceType: "auto-scaling-group",
              Key,
            })),
          } as any);
        }

        if (upsert.length > 0) {
          yield* autoscaling.createOrUpdateTags({
            Tags: upsert.map(({ Key, Value }) => ({
              ResourceId: autoScalingGroupName,
              ResourceType: "auto-scaling-group",
              Key,
              Value,
              PropagateAtLaunch: false,
            })),
          } as any);
        }
      });

      const toAttributes = (
        group: autoscaling.AutoScalingGroup,
      ): AutoScalingGroup["Attributes"] => ({
        autoScalingGroupArn: group.AutoScalingGroupARN!,
        autoScalingGroupName: group.AutoScalingGroupName!,
        launchTemplateId: group.LaunchTemplate?.LaunchTemplateId,
        launchTemplateName: group.LaunchTemplate?.LaunchTemplateName,
        launchTemplateVersion: group.LaunchTemplate?.Version,
        subnetIds: String(group.VPCZoneIdentifier ?? "")
          .split(",")
          .filter(Boolean),
        minSize: group.MinSize ?? 0,
        maxSize: group.MaxSize ?? 0,
        desiredCapacity: group.DesiredCapacity ?? 0,
        targetGroupArns: sortStrings(group.TargetGroupARNs ?? []),
        healthCheckType: group.HealthCheckType,
        healthCheckGracePeriod: group.HealthCheckGracePeriod,
        defaultCooldown: group.DefaultCooldown,
        terminationPolicies: group.TerminationPolicies ?? [],
        tags: Object.fromEntries(
          (group.Tags ?? [])
            .filter((tag): tag is { Key: string; Value: string } =>
              Boolean(tag.Key && tag.Value !== undefined),
            )
            .map((tag) => [tag.Key, tag.Value]),
        ),
      });

      return {
        stables: ["autoScalingGroupArn", "autoScalingGroupName"],
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace", deleteFirst: true } as const;
          }

          if (!deepEqual(olds, news)) {
            return {
              action: "update",
              stables: ["autoScalingGroupArn", "autoScalingGroupName"],
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.autoScalingGroupName ?? (yield* toName(id, olds ?? {}));
          const group = yield* describeGroup(name);
          return group ? toAttributes(group) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const autoScalingGroupName =
            output?.autoScalingGroupName ?? (yield* toName(id, news));
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const targetGroupArns = sortStrings(
            (news.targetGroupArns ?? []) as string[],
          );
          const launchTemplate = toLaunchTemplateSpec(news.launchTemplate);
          const healthCheckType =
            news.healthCheckType ??
            (targetGroupArns.length > 0 ? "ELB" : "EC2");

          // Observe — fetch live state. `describeAutoScalingGroups` returns
          // an empty list when the ASG is missing; we never trust `output`
          // alone since the ASG may have been deleted out of band.
          let existing = yield* describeGroup(autoScalingGroupName);

          // Ensure — create the ASG if missing. `createAutoScalingGroup`
          // raises `AlreadyExistsFault` on a race; we fall through to the
          // sync path on that case.
          if (!existing) {
            yield* autoscaling
              .createAutoScalingGroup({
                AutoScalingGroupName: autoScalingGroupName,
                MinSize: news.minSize,
                MaxSize: news.maxSize,
                DesiredCapacity: news.desiredCapacity ?? news.minSize,
                LaunchTemplate: launchTemplate,
                VPCZoneIdentifier: (news.subnetIds as string[]).join(","),
                TargetGroupARNs: targetGroupArns,
                HealthCheckType: healthCheckType,
                HealthCheckGracePeriod: news.healthCheckGracePeriod,
                DefaultCooldown: news.defaultCooldown,
                TerminationPolicies: news.terminationPolicies,
                Tags: toTags(autoScalingGroupName, desiredTags),
              } as any)
              .pipe(
                Effect.catch((error: any) =>
                  error?._tag === "AlreadyExistsFault"
                    ? Effect.void
                    : Effect.fail(error),
                ),
              );

            existing = yield* describeGroup(autoScalingGroupName).pipe(
              Effect.filterOrFail(
                Boolean,
                () =>
                  new Error(
                    `Auto Scaling Group '${autoScalingGroupName}' was not readable after create`,
                  ),
              ),
              Effect.retry({
                while: () => true,
                schedule: Schedule.recurs(8).pipe(
                  Schedule.both(Schedule.exponential("250 millis")),
                ),
              }),
            );
          }

          // Sync core ASG configuration — `updateAutoScalingGroup`
          // overwrites min/max/desired/template/subnets/health-check
          // settings in one call, so we issue it unconditionally
          // (idempotent for matching values).
          yield* autoscaling.updateAutoScalingGroup({
            AutoScalingGroupName: autoScalingGroupName,
            MinSize: news.minSize,
            MaxSize: news.maxSize,
            DesiredCapacity: news.desiredCapacity ?? news.minSize,
            LaunchTemplate: launchTemplate,
            VPCZoneIdentifier: (news.subnetIds as string[]).join(","),
            HealthCheckType: healthCheckType,
            HealthCheckGracePeriod: news.healthCheckGracePeriod,
            DefaultCooldown: news.defaultCooldown,
            TerminationPolicies: news.terminationPolicies,
          } as any);

          // Sync target groups — observed cloud attachments vs desired.
          const observedAttrs = toAttributes(existing);
          yield* syncTargetGroups({
            autoScalingGroupName,
            oldTargetGroupArns: sortStrings(existing.TargetGroupARNs ?? []),
            newTargetGroupArns: targetGroupArns,
          });

          // Sync tags — observed cloud tags vs desired. Adoption brings
          // tags through `existing.Tags`; we converge regardless of what
          // was there before.
          yield* syncTags({
            autoScalingGroupName,
            oldTags: observedAttrs.tags,
            newTags: desiredTags,
          });

          // Re-read final state so attributes reflect post-sync cloud
          // state.
          const group = yield* describeGroup(autoScalingGroupName).pipe(
            Effect.filterOrFail(
              Boolean,
              () =>
                new Error(
                  `Auto Scaling Group '${autoScalingGroupName}' was not readable after reconcile`,
                ),
            ),
          );
          yield* session.note(autoScalingGroupName);
          return toAttributes(group);
        }),
        delete: Effect.fn(function* ({ output }) {
          const existing = yield* describeGroup(output.autoScalingGroupName);
          if (!existing) {
            return;
          }

          yield* autoscaling.deleteAutoScalingGroup({
            AutoScalingGroupName: output.autoScalingGroupName,
            ForceDelete: true,
          } as any);

          yield* describeGroup(output.autoScalingGroupName).pipe(
            Effect.flatMap((group) =>
              group
                ? Effect.fail(new Error("AutoScalingGroupStillExists"))
                : Effect.void,
            ),
            Effect.retry({
              while: (error) =>
                (error as Error).message === "AutoScalingGroupStillExists",
              schedule: Schedule.recurs(12).pipe(
                Schedule.both(Schedule.exponential("250 millis")),
              ),
            }),
          );
        }),
      };
    }),
  );
