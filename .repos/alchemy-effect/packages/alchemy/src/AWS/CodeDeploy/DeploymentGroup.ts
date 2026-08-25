import * as codedeploy from "@distilled.cloud/aws/codedeploy";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireMinutes } from "../../Util/Duration.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Blue/green deployment behaviour for a deployment group. Mirrors the wire
 * `BlueGreenDeploymentConfiguration` with `Duration.Input` wait times
 * (CodeDeploy's wire unit for both is whole minutes).
 */
export interface BlueGreenDeploymentConfigurationProps {
  /**
   * What happens to the original (blue) instances after a successful
   * blue/green deployment.
   */
  terminateBlueInstancesOnDeploymentSuccess?: {
    /**
     * `TERMINATE` the blue instances (after `terminationWaitTime`) or
     * `KEEP_ALIVE` them deregistered from the load balancer.
     */
    action?: codedeploy.InstanceAction;
    /**
     * How long to wait after a successful deployment before terminating
     * the blue instances. Wire unit: whole minutes.
     */
    terminationWaitTime?: Duration.Input;
  };
  /**
   * How traffic is rerouted to the green fleet once it is provisioned.
   */
  deploymentReadyOption?: {
    /**
     * `CONTINUE_DEPLOYMENT` reroutes automatically; `STOP_DEPLOYMENT`
     * waits for {@link ContinueDeployment} (up to `waitTime`).
     */
    actionOnTimeout?: codedeploy.DeploymentReadyAction;
    /**
     * How long to wait for a manual continue before the deployment stops
     * (only with `actionOnTimeout: "STOP_DEPLOYMENT"`). Wire unit: whole
     * minutes.
     */
    waitTime?: Duration.Input;
  };
  /**
   * How the green fleet's instances are provisioned (discover existing or
   * copy the Auto Scaling group).
   */
  greenFleetProvisioningOption?: codedeploy.GreenFleetProvisioningOption;
}

/** Convert the blue/green props to the CodeDeploy wire shape (minutes). */
const toWireBlueGreen = (
  props: BlueGreenDeploymentConfigurationProps | undefined,
): codedeploy.BlueGreenDeploymentConfiguration | undefined =>
  props === undefined
    ? undefined
    : {
        terminateBlueInstancesOnDeploymentSuccess:
          props.terminateBlueInstancesOnDeploymentSuccess === undefined
            ? undefined
            : {
                action: props.terminateBlueInstancesOnDeploymentSuccess.action,
                terminationWaitTimeInMinutes: toWireMinutes(
                  props.terminateBlueInstancesOnDeploymentSuccess
                    .terminationWaitTime,
                ),
              },
        deploymentReadyOption:
          props.deploymentReadyOption === undefined
            ? undefined
            : {
                actionOnTimeout: props.deploymentReadyOption.actionOnTimeout,
                waitTimeInMinutes: toWireMinutes(
                  props.deploymentReadyOption.waitTime,
                ),
              },
        greenFleetProvisioningOption: props.greenFleetProvisioningOption,
      };

export interface DeploymentGroupProps {
  /**
   * Name of the CodeDeploy application that owns the group. Pass an
   * `Application`'s `applicationName` attribute. Immutable — changing it
   * replaces the deployment group.
   */
  applicationName: string;
  /**
   * Name of the deployment group (1-100 chars). If omitted a deterministic
   * physical name is generated. Changing the name replaces the group.
   */
  deploymentGroupName?: string;
  /**
   * ARN of the IAM service role that grants CodeDeploy access to the target
   * compute resources. Required.
   */
  serviceRoleArn: string;
  /**
   * Name of the deployment configuration (predefined like
   * `CodeDeployDefault.LambdaAllAtOnce`, or a custom `DeploymentConfig`).
   */
  deploymentConfigName?: string;
  /**
   * How the deployment routes traffic (in-place vs. blue/green).
   */
  deploymentStyle?: codedeploy.DeploymentStyle;
  /**
   * Automatic rollback behaviour on deployment failure or alarm.
   */
  autoRollbackConfiguration?: codedeploy.AutoRollbackConfiguration;
  /**
   * CloudWatch alarms that can stop a deployment.
   */
  alarmConfiguration?: codedeploy.AlarmConfiguration;
  /**
   * Load-balancer configuration used for traffic shifting.
   */
  loadBalancerInfo?: codedeploy.LoadBalancerInfo;
  /**
   * Blue/green deployment configuration (green-fleet provisioning, traffic
   * ready-options, blue-instance termination). Wait times accept
   * `Duration.Input` (e.g. `"5 minutes"`).
   */
  blueGreenDeploymentConfiguration?: BlueGreenDeploymentConfigurationProps;
  /**
   * EC2 tag filters selecting the instances to deploy to (EC2/on-prem
   * `Server` platform).
   */
  ec2TagFilters?: codedeploy.EC2TagFilter[];
  /**
   * Auto Scaling group names to deploy to (EC2/on-prem `Server` platform).
   */
  autoScalingGroups?: string[];
  /**
   * ECS services (cluster + service) targeted by blue/green ECS deployments.
   */
  ecsServices?: codedeploy.ECSService[];
  /**
   * SNS/notification triggers fired on deployment lifecycle events.
   */
  triggerConfigurations?: codedeploy.TriggerConfig[];
  /**
   * User-defined tags.
   */
  tags?: Record<string, string>;
}

export interface DeploymentGroup extends Resource<
  "AWS.CodeDeploy.DeploymentGroup",
  DeploymentGroupProps,
  {
    /** Physical name of the deployment group. */
    deploymentGroupName: string;
    /** Unique CodeDeploy-assigned deployment-group ID. */
    deploymentGroupId: string;
    /** ARN of the deployment group. */
    deploymentGroupArn: string;
    /** Name of the application this group belongs to. */
    applicationName: string;
    /** ARN of the service role CodeDeploy assumes for deployments. */
    serviceRoleArn: string;
  },
  never,
  Providers
> {}

/**
 * An AWS CodeDeploy deployment group — the set of target instances/functions
 * plus the deployment configuration for one {@link Application}. For the
 * `Lambda` compute platform a group ties a service role and a deployment
 * config (e.g. `CodeDeployDefault.LambdaAllAtOnce`) to an application.
 *
 * @resource
 * @section Creating a Deployment Group
 * @example Lambda Deployment Group
 * ```typescript
 * const app = yield* CodeDeploy.Application("api", { computePlatform: "Lambda" });
 * const group = yield* CodeDeploy.DeploymentGroup("prod", {
 *   applicationName: app.applicationName,
 *   serviceRoleArn: role.roleArn,
 *   deploymentConfigName: "CodeDeployDefault.LambdaAllAtOnce",
 *   deploymentStyle: {
 *     deploymentType: "BLUE_GREEN",
 *     deploymentOption: "WITH_TRAFFIC_CONTROL",
 *   },
 *   autoRollbackConfiguration: {
 *     enabled: true,
 *     events: ["DEPLOYMENT_FAILURE"],
 *   },
 * });
 * ```
 */
export const DeploymentGroup = Resource<DeploymentGroup>(
  "AWS.CodeDeploy.DeploymentGroup",
);

/** Build the ARN for a CodeDeploy deployment group. */
const deploymentGroupArn = (
  region: string,
  account: string,
  appName: string,
  groupName: string,
): string =>
  `arn:aws:codedeploy:${region}:${account}:deploymentgroup:${appName}/${groupName}`;

/**
 * Retry an effect while CodeDeploy reports that it cannot yet assume the
 * service role. A freshly-created IAM role's trust relationship is eventually
 * consistent, so `InvalidRoleException` immediately after role creation is a
 * transient propagation error, not a permanent failure. Wrapped in an
 * explicitly-typed helper so the retry's conditional type never widens the
 * provider layer in declaration emit (see PATTERNS §7).
 */
const retryThroughRolePropagation = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.retry({
      while: (e: E) => e._tag === "InvalidRoleException",
      schedule: Schedule.max([Schedule.fixed(2000), Schedule.recurs(15)]),
    }),
  );

/** Convert a CodeDeploy wire tag list into a plain record. */
const toTagRecord = (
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const DeploymentGroupProvider = () =>
  Provider.effect(
    DeploymentGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<DeploymentGroupProps>) =>
        props.deploymentGroupName
          ? Effect.succeed(props.deploymentGroupName)
          : createPhysicalName({ id, maxLength: 100 });

      const getGroup = Effect.fn(function* (
        appName: string,
        groupName: string,
      ) {
        const response = yield* codedeploy
          .getDeploymentGroup({
            applicationName: appName,
            deploymentGroupName: groupName,
          })
          .pipe(
            Effect.catchTag(
              [
                "DeploymentGroupDoesNotExistException",
                "ApplicationDoesNotExistException",
              ],
              () => Effect.succeed(undefined),
            ),
          );
        return response?.deploymentGroupInfo;
      });

      const syncTags = Effect.fn(function* (
        arn: string,
        desiredTags: Record<string, string>,
      ) {
        const observed = yield* codedeploy
          .listTagsForResource({ ResourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        const { removed, upsert } = diffTags(
          toTagRecord(observed?.Tags),
          desiredTags,
        );
        if (upsert.length > 0) {
          yield* codedeploy.tagResource({ ResourceArn: arn, Tags: upsert });
        }
        if (removed.length > 0) {
          yield* codedeploy.untagResource({
            ResourceArn: arn,
            TagKeys: removed,
          });
        }
      });

      return {
        stables: [
          "deploymentGroupName",
          "deploymentGroupId",
          "applicationName",
        ],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // The parent application is immutable — replace on change.
          if ((news?.applicationName ?? "") !== (olds?.applicationName ?? "")) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const appName = output?.applicationName ?? olds?.applicationName;
          if (appName === undefined) return undefined;
          const name =
            output?.deploymentGroupName ?? (yield* toName(id, olds ?? {}));
          const group = yield* getGroup(appName, name);
          if (group?.deploymentGroupId === undefined) return undefined;
          const arn = deploymentGroupArn(region, accountId, appName, name);
          const attrs = {
            deploymentGroupName: group.deploymentGroupName ?? name,
            deploymentGroupId: group.deploymentGroupId,
            deploymentGroupArn: arn,
            applicationName: group.applicationName ?? appName,
            serviceRoleArn: group.serviceRoleArn ?? "",
          };
          const tags = yield* codedeploy
            .listTagsForResource({ ResourceArn: arn })
            .pipe(
              Effect.map((res) => toTagRecord(res.Tags)),
              Effect.catch(() => Effect.succeed({})),
            );
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const appName = news.applicationName;
          const name = output?.deploymentGroupName ?? (yield* toName(id, news));
          const arn = deploymentGroupArn(region, accountId, appName, name);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let group = yield* getGroup(appName, name);

          // 2. Ensure — create if missing; otherwise converge via update.
          if (group?.deploymentGroupId === undefined) {
            yield* retryThroughRolePropagation(
              codedeploy.createDeploymentGroup({
                applicationName: appName,
                deploymentGroupName: name,
                serviceRoleArn: news.serviceRoleArn,
                deploymentConfigName: news.deploymentConfigName,
                deploymentStyle: news.deploymentStyle,
                autoRollbackConfiguration: news.autoRollbackConfiguration,
                alarmConfiguration: news.alarmConfiguration,
                loadBalancerInfo: news.loadBalancerInfo,
                blueGreenDeploymentConfiguration: toWireBlueGreen(
                  news.blueGreenDeploymentConfiguration,
                ),
                ec2TagFilters: news.ec2TagFilters,
                autoScalingGroups: news.autoScalingGroups,
                ecsServices: news.ecsServices,
                triggerConfigurations: news.triggerConfigurations,
                tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            ).pipe(
              Effect.catchTag("DeploymentGroupAlreadyExistsException", () =>
                Effect.succeed(undefined),
              ),
            );
            group = yield* getGroup(appName, name);
          } else {
            // 3. Sync — converge mutable configuration in place.
            yield* codedeploy.updateDeploymentGroup({
              applicationName: appName,
              currentDeploymentGroupName: name,
              serviceRoleArn: news.serviceRoleArn,
              deploymentConfigName: news.deploymentConfigName,
              deploymentStyle: news.deploymentStyle,
              autoRollbackConfiguration: news.autoRollbackConfiguration,
              alarmConfiguration: news.alarmConfiguration,
              loadBalancerInfo: news.loadBalancerInfo,
              blueGreenDeploymentConfiguration: toWireBlueGreen(
                news.blueGreenDeploymentConfiguration,
              ),
              ec2TagFilters: news.ec2TagFilters,
              autoScalingGroups: news.autoScalingGroups,
              ecsServices: news.ecsServices,
              triggerConfigurations: news.triggerConfigurations,
            });
            group = yield* getGroup(appName, name);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          yield* syncTags(arn, desiredTags);

          // 4. Return fresh attributes.
          yield* session.note(name);
          return {
            deploymentGroupName: group?.deploymentGroupName ?? name,
            deploymentGroupId: group?.deploymentGroupId ?? "",
            deploymentGroupArn: arn,
            applicationName: group?.applicationName ?? appName,
            serviceRoleArn: group?.serviceRoleArn ?? news.serviceRoleArn,
          };
        }),

        delete: Effect.fn(function* ({ output, olds }) {
          const appName = output.applicationName || olds?.applicationName;
          if (appName === undefined) return;
          // DeleteDeploymentGroup is idempotent — deleting a non-existent
          // group (or one under a deleted application) succeeds; its typed
          // error union has no not-found variants.
          yield* codedeploy.deleteDeploymentGroup({
            applicationName: appName,
            deploymentGroupName: output.deploymentGroupName,
          });
        }),

        // Deployment groups are scoped to an application; there is no global
        // enumeration without knowing the application name.
        list: () => Effect.succeed([]),
      };
    }),
  );
