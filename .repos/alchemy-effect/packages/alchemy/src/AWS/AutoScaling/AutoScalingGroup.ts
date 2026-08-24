import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toSeconds } from "../../Util/Duration.ts";
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
  /**
   * ID of the launch template (`lt-...`). Provide either the ID or the name,
   * not both.
   */
  launchTemplateId?: Input<LaunchTemplateId>;
  /**
   * Name of the launch template. Provide either the ID or the name, not both.
   */
  launchTemplateName?: Input<LaunchTemplateName>;
  /**
   * Template version to launch.
   * @default "$Default"
   */
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
   * Grace period before health checks start, e.g. `"5 minutes"` or
   * `Duration.seconds(300)` (whole seconds on the wire).
   */
  healthCheckGracePeriod?: Duration.Input;
  /**
   * Default cooldown between scaling activities, e.g. `"5 minutes"` or
   * `Duration.seconds(300)` (whole seconds on the wire).
   */
  defaultCooldown?: Duration.Input;
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
    /**
     * ARN of the Auto Scaling Group.
     */
    autoScalingGroupArn: string;
    /**
     * Name of the Auto Scaling Group.
     */
    autoScalingGroupName: AutoScalingGroupName;
    /**
     * ID of the launch template used by the fleet.
     */
    launchTemplateId?: string;
    /**
     * Name of the launch template used by the fleet.
     */
    launchTemplateName?: string;
    /**
     * Launch template version used by the fleet (e.g. `"$Default"` or a
     * version number).
     */
    launchTemplateVersion?: string;
    /**
     * Subnets the fleet is placed into.
     */
    subnetIds: string[];
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
     */
    desiredCapacity: number;
    /**
     * Load balancer target groups the fleet is registered with.
     */
    targetGroupArns: string[];
    /**
     * Health check type (`EC2` or `ELB`).
     */
    healthCheckType?: string;
    /**
     * Grace period in seconds before health checks start.
     */
    healthCheckGracePeriod?: number;
    /**
     * Default cooldown in seconds between scaling activities.
     */
    defaultCooldown?: number;
    /**
     * Termination policies applied on scale-in.
     */
    terminationPolicies?: string[];
    /**
     * Tags on the Auto Scaling Group.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An EC2 Auto Scaling Group that manages a fleet of instances from a launch
 * template and can register that fleet with one or more load balancer target
 * groups.
 *
 * Pair with {@link ScalingPolicy} for target-tracking scaling,
 * {@link ScheduledAction} for time-based capacity changes, and
 * {@link consumeLifecycleActions} to run a Lambda handler while instances
 * pause during launch/terminate transitions.
 * @resource
 * @section Creating an Auto Scaling Group
 * @example Fleet from a Launch Template
 * ```typescript
 * import { AutoScalingGroup, LaunchTemplate } from "alchemy/AWS/AutoScaling";
 * import { Subnet, Vpc } from "alchemy/AWS/EC2";
 *
 * const vpc = yield* Vpc("Vpc", { cidrBlock: "10.0.0.0/16" });
 * const subnet = yield* Subnet("Subnet", {
 *   vpcId: vpc.vpcId,
 *   cidrBlock: "10.0.1.0/24",
 * });
 *
 * const template = yield* LaunchTemplate("Template", {
 *   imageId: "ami-0abcdef1234567890",
 *   instanceType: "t3.micro",
 * });
 *
 * const group = yield* AutoScalingGroup("Fleet", {
 *   launchTemplate: template,
 *   subnetIds: [subnet.subnetId],
 *   minSize: 1,
 *   maxSize: 3,
 * });
 * ```
 *
 * @example Reference an existing Launch Template by name
 * ```typescript
 * const group = yield* AutoScalingGroup("Fleet", {
 *   launchTemplate: { launchTemplateName: "my-template", version: 2 },
 *   subnetIds: [subnet.subnetId],
 *   minSize: 0,
 *   maxSize: 0,
 *   desiredCapacity: 0,
 * });
 * ```
 *
 * @section Load Balancing
 * @example Register the fleet with a target group
 * ```typescript
 * const group = yield* AutoScalingGroup("WebFleet", {
 *   launchTemplate: template,
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   minSize: 2,
 *   maxSize: 6,
 *   targetGroupArns: [targetGroup.targetGroupArn],
 *   // healthCheckType defaults to "ELB" when target groups are attached
 *   healthCheckGracePeriod: "5 minutes",
 * });
 * ```
 *
 * @section Scaling
 * @example Track average CPU utilization
 * ```typescript
 * import { ScalingPolicy } from "alchemy/AWS/AutoScaling";
 *
 * yield* ScalingPolicy("CpuPolicy", {
 *   autoScalingGroup: group,
 *   predefinedMetricType: "ASGAverageCPUUtilization",
 *   targetValue: 60,
 * });
 * ```
 */
export const AutoScalingGroup = Resource<AutoScalingGroup>(
  "AWS.AutoScaling.AutoScalingGroup",
);

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
        // A whole-resource `launchTemplate: template` resolves to the
        // LaunchTemplate's bare Attributes before reaching the provider —
        // the resource `Type` marker does not survive resolution — so narrow
        // on the attributes shape (`launchTemplateArn` exists only on
        // attributes, never on a LaunchTemplateReference). Attributes carry
        // BOTH id and name, and the API rejects a spec with both, so send
        // the id alone.
        const attrs = input as
          | Partial<LaunchTemplateResource["Attributes"]>
          | undefined;
        if (typeof attrs?.launchTemplateArn === "string") {
          return {
            LaunchTemplateId: attrs.launchTemplateId as string | undefined,
            LaunchTemplateName: undefined,
            Version:
              attrs.defaultVersionNumber === undefined
                ? "$Default"
                : String(attrs.defaultVersionNumber),
          };
        }

        const spec = (input ?? {}) as LaunchTemplateReference;
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
        list: () =>
          // `describeAutoScalingGroups` is paginated; collect every page and
          // flatten the `AutoScalingGroups` array into full `Attributes`.
          autoscaling.describeAutoScalingGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.AutoScalingGroups ?? []).map(toAttributes),
              ),
            ),
          ),
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
                HealthCheckGracePeriod: toSeconds(news.healthCheckGracePeriod),
                DefaultCooldown: toSeconds(news.defaultCooldown),
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
                schedule: Schedule.max([
                  Schedule.recurs(8),
                  Schedule.exponential("250 millis"),
                ]),
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
            HealthCheckGracePeriod: toSeconds(news.healthCheckGracePeriod),
            DefaultCooldown: toSeconds(news.defaultCooldown),
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
              schedule: Schedule.max([
                Schedule.recurs(12),
                Schedule.exponential("250 millis"),
              ]),
            }),
          );
        }),
      };
    }),
  );
