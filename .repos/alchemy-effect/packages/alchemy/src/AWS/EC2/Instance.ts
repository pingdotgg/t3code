import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as ec2 from "@distilled.cloud/aws/ec2";
import { Region } from "@distilled.cloud/aws/Region";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { ServerHost } from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import {
  createAlchemyTagFilters,
  createInternalTags,
  diffTags,
} from "../../Tags.ts";
import { Assets } from "../Assets.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import {
  createEc2HostRuntimeContext,
  createEc2HostedSupport,
  type Ec2HostRuntimeContext,
} from "./hosted.ts";
import type { SecurityGroupId } from "./SecurityGroup.ts";
import type { SubnetId } from "./Subnet.ts";
import type { VpcId } from "./Vpc.ts";

export type InstanceId<ID extends string = string> = `i-${ID}`;
export const InstanceId = <ID extends string>(id: ID): ID & InstanceId<ID> =>
  `i-${id}` as ID & InstanceId<ID>;

export type InstanceArn<ID extends InstanceId = InstanceId> =
  `arn:aws:ec2:${RegionID}:${AccountID}:instance/${ID}`;

export const isInstance = (value: any): value is Instance => {
  return (
    typeof value === "object" &&
    value !== null &&
    "Type" in value &&
    value.Type === "AWS.EC2.Instance"
  );
};

export interface InstanceProps extends PlatformProps {
  /**
   * AMI ID to launch.
   */
  imageId: string;
  /**
   * EC2 instance type, such as `t3.micro`.
   */
  instanceType: string;
  /**
   * Optional subnet to launch into.
   */
  subnetId?: Input<SubnetId>;
  /**
   * Security groups to attach to the primary network interface.
   */
  securityGroupIds?: Input<SecurityGroupId>[];
  /**
   * Optional EC2 key pair name for SSH access.
   */
  keyName?: string;
  /**
   * Optional IAM instance profile name to attach at launch.
   */
  instanceProfileName?: string;
  /**
   * User data script to provide at launch time.
   */
  userData?: string;
  /**
   * Whether to associate a public IPv4 address on launch.
   */
  associatePublicIpAddress?: boolean;
  /**
   * Optional private IPv4 address for the primary interface.
   */
  privateIpAddress?: string;
  /**
   * Optional availability zone override.
   */
  availabilityZone?: string;
  /**
   * Whether source/destination checking is enabled.
   * @default true
   */
  sourceDestCheck?: boolean;
  /**
   * User-defined tags to apply to the instance.
   */
  tags?: Record<string, string>;
  /**
   * Module entrypoint for the bundled instance program.
   * When omitted, the instance behaves as a low-level EC2 resource.
   */
  main?: string;
  /**
   * Named export to load from `main`.
   * @default "default"
   */
  handler?: string;
  /**
   * Port exposed by the process, if any.
   * @default 3000
   */
  port?: number;
  /**
   * Additional environment variables for the hosted process.
   */
  env?: Record<string, any>;
  /**
   * Bundler configuration for the hosted process entrypoint.
   */
  build?: {
    input?: Partial<rolldown.InputOptions>;
    output?: Partial<rolldown.OutputOptions>;
  };
  /**
   * Additional managed policy ARNs for the managed instance role.
   * This can only be used when Alchemy manages the instance profile.
   */
  roleManagedPolicyArns?: string[];
}

export interface Instance extends Resource<
  "AWS.EC2.Instance",
  InstanceProps,
  {
    /**
     * The ID of the instance.
     */
    instanceId: InstanceId;
    /**
     * The Amazon Resource Name (ARN) of the instance.
     */
    instanceArn: InstanceArn;
    /**
     * The AMI ID the instance launched from.
     */
    imageId: string;
    /**
     * The instance type.
     */
    instanceType: string;
    /**
     * The current instance state.
     */
    state: string;
    /**
     * The VPC the instance belongs to, if any.
     */
    vpcId?: VpcId;
    /**
     * The subnet the instance belongs to, if any.
     */
    subnetId?: SubnetId;
    /**
     * The availability zone of the instance.
     */
    availabilityZone?: string;
    /**
     * The attached security group IDs.
     */
    securityGroupIds: string[];
    /**
     * The primary private IPv4 address.
     */
    privateIpAddress?: string;
    /**
     * The public IPv4 address, if assigned.
     */
    publicIpAddress?: string;
    /**
     * The private DNS name.
     */
    privateDnsName?: string;
    /**
     * The public DNS name, if assigned.
     */
    publicDnsName?: string;
    /**
     * The key pair name used for SSH access.
     */
    keyName?: string;
    /**
     * The IAM instance profile ARN attached to the instance, if any.
     */
    instanceProfileArn?: string;
    /**
     * The IAM instance profile ID attached to the instance, if any.
     */
    instanceProfileId?: string;
    /**
     * The IAM instance profile name attached to the instance, if known.
     */
    instanceProfileName?: string;
    /**
     * Whether source/destination checking is enabled.
     */
    sourceDestCheck?: boolean;
    /**
     * When the instance was launched.
     */
    launchTime?: string;
    /**
     * Current tags on the instance.
     */
    tags: Record<string, string>;
    /**
     * Role attached by the hosted runtime, if any.
     */
    roleArn?: string;
    /**
     * Role name attached by the hosted runtime, if any.
     */
    roleName?: string;
    /**
     * Inline policy name used for bindings/runtime sync, if any.
     */
    policyName?: string;
    /**
     * Whether the role/profile were created and owned by Alchemy.
     */
    managedIam?: boolean;
    /**
     * Deterministic runtime unit name for hosted instances.
     */
    runtimeUnitName?: string;
    /**
     * Asset prefix for hosted bundles and env files.
     */
    assetPrefix?: string;
    /**
     * Bundle hash for hosted instances.
     */
    code?: {
      hash: string;
    };
  },
  {
    env?: Record<string, any>;
    policyStatements?: PolicyStatement[];
  },
  Providers
> {}

export type InstanceServices = ServerHost | Credentials | Region;

export type InstanceShape = Main<InstanceServices>;

export type InstanceRuntimeContext = Ec2HostRuntimeContext;

/**
 * An EC2 instance that can either act as a low-level compute primitive or run
 * a bundled long-lived Effect program directly on the machine.
 *
 * @section Launching Instances
 * @example Basic Instance
 * ```typescript
 * const instance = yield* AWS.EC2.Instance("AppInstance", {
 *   imageId,
 *   instanceType: "t3.micro",
 *   subnetId: subnet.subnetId,
 * });
 * ```
 *
 * @section Hosting Processes
 * @example HTTP Server on an Instance
 * ```typescript
 * const api = yield* Effect.gen(function* () {
 *   yield* Http.serve(
 *     HttpServerResponse.json({ ok: true }),
 *   );
 *
 *   return {
 *     main: import.meta.filename,
 *     imageId,
 *     instanceType: "t3.small",
 *     subnetId: subnet.subnetId,
 *     securityGroupIds: [securityGroup.groupId],
 *     associatePublicIpAddress: true,
 *     port: 3000,
 *   };
 * }).pipe(
 *   Effect.provide(AWS.EC2.HttpServer),
 *   AWS.EC2.Instance("ApiInstance"),
 * );
 * ```
 */
export const Instance: Platform<
  Instance,
  InstanceServices,
  InstanceShape,
  InstanceRuntimeContext
> = Platform("AWS.EC2.Instance", {
  createRuntimeContext: createEc2HostRuntimeContext("AWS.EC2.Instance"),
});

export const InstanceProvider = () =>
  Provider.effect(
    Instance,
    Effect.gen(function* () {
      const region = yield* Region;
      const { accountId } = yield* AWSEnvironment;
      const stack = yield* Stack;
      const stage = yield* Stage;
      const fs = yield* FileSystem.FileSystem;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const assets = (yield* Effect.serviceOption(Assets)).pipe(
        Option.getOrUndefined,
      );

      const toInstanceArn = (instanceId: InstanceId) =>
        `arn:aws:ec2:${region}:${accountId}:instance/${instanceId}` as InstanceArn;

      const hosted = createEc2HostedSupport({
        accountId,
        region,
        stackName: stack.name,
        stage,
        fs,
        virtualEntryPlugin,
        assets,
        resourceType: "EC2.Instance",
      });

      const isPendingInstanceProfileError = (error: unknown) => {
        const tag = (error as { _tag?: string })?._tag;
        if (
          tag === "InvalidIAMInstanceProfile.NotFound" ||
          tag === "InvalidParameterValue"
        ) {
          return true;
        }
        if (tag !== "UnknownAwsError") {
          return false;
        }
        const unknown = error as {
          errorTag?: string;
          message?: string;
          errorData?: {
            message?: string;
            Message?: string;
          };
        };
        const message =
          unknown.message ??
          unknown.errorData?.message ??
          unknown.errorData?.Message ??
          "";
        return (
          unknown.errorTag === "InvalidParameterValue" &&
          message.includes("iamInstanceProfile.name") &&
          message.includes("Invalid IAM Instance Profile name")
        );
      };

      const isPendingInstanceLookupError = (error: unknown) => {
        const tag = (error as { _tag?: string })?._tag;
        return (
          error instanceof InstanceNotFound ||
          tag === "InvalidInstanceID.NotFound"
        );
      };

      const toTagRecord = (tags?: Array<{ Key?: string; Value?: string }>) =>
        Object.fromEntries(
          (tags ?? [])
            .filter((tag): tag is { Key: string; Value: string } =>
              Boolean(tag.Key && tag.Value !== undefined),
            )
            .map((tag) => [tag.Key, tag.Value]),
        );

      const toAttributes = (
        instance: ec2.Instance,
      ): Instance["Attributes"] => ({
        instanceId: instance.InstanceId as InstanceId,
        instanceArn: toInstanceArn(instance.InstanceId as InstanceId),
        imageId: instance.ImageId!,
        instanceType: String(instance.InstanceType ?? ""),
        state: instance.State?.Name ?? "unknown",
        vpcId: instance.VpcId as VpcId | undefined,
        subnetId: instance.SubnetId as SubnetId | undefined,
        availabilityZone: instance.Placement?.AvailabilityZone,
        securityGroupIds: (instance.SecurityGroups ?? [])
          .map((group) => group.GroupId)
          .filter((value): value is string => Boolean(value)),
        privateIpAddress: instance.PrivateIpAddress,
        publicIpAddress: instance.PublicIpAddress,
        privateDnsName: instance.PrivateDnsName,
        publicDnsName: instance.PublicDnsName,
        keyName: instance.KeyName,
        instanceProfileArn: instance.IamInstanceProfile?.Arn,
        instanceProfileId: instance.IamInstanceProfile?.Id,
        instanceProfileName: undefined,
        sourceDestCheck: instance.SourceDestCheck,
        launchTime:
          instance.LaunchTime instanceof Date
            ? instance.LaunchTime.toISOString()
            : (instance.LaunchTime as string | undefined),
        tags: toTagRecord(instance.Tags),
      });

      const describeInstance = (instanceId: string) =>
        ec2
          .describeInstances({
            InstanceIds: [instanceId],
          })
          .pipe(
            Effect.map(
              (result) =>
                (result.Reservations ?? []).flatMap(
                  (reservation) => reservation.Instances ?? [],
                )[0],
            ),
            Effect.flatMap((instance) =>
              instance
                ? Effect.succeed(instance)
                : Effect.fail(new InstanceNotFound({ instanceId })),
            ),
          );

      const findInstanceByTags = Effect.fn(function* (id: string) {
        const filters = yield* createAlchemyTagFilters(id);
        return yield* ec2.describeInstances
          .items({
            Filters: filters,
          })
          .pipe(
            Stream.flatMap((reservation) =>
              Stream.fromArray(reservation.Instances ?? []),
            ),
            Stream.filter((instance) => {
              const state = instance.State?.Name;
              return (
                state === "pending" ||
                state === "running" ||
                state === "stopping" ||
                state === "stopped"
              );
            }),
            Stream.runCollect,
            Effect.map(
              (instances) =>
                [...instances].sort((a, b) => {
                  const aTime =
                    a.LaunchTime instanceof Date
                      ? a.LaunchTime.getTime()
                      : Date.parse(String(a.LaunchTime ?? 0));
                  const bTime =
                    b.LaunchTime instanceof Date
                      ? b.LaunchTime.getTime()
                      : Date.parse(String(b.LaunchTime ?? 0));
                  return bTime - aTime;
                })[0],
            ),
          );
      });

      const waitForState = Effect.fn(function* ({
        instanceId,
        states,
        session,
      }: {
        instanceId: string;
        states: string[];
        session: Pick<ScopedPlanStatusSession, "note">;
      }) {
        return yield* describeInstance(instanceId).pipe(
          Effect.tap((instance) =>
            session.note(
              `Waiting for instance ${instanceId}: ${instance.State?.Name ?? "unknown"}`,
            ),
          ),
          Effect.filterOrFail(
            (instance) => states.includes(instance.State?.Name ?? ""),
            (instance) =>
              new InstanceStateMismatch({
                instanceId,
                actual: instance.State?.Name ?? "unknown",
                expected: states,
              }),
          ),
          Effect.retry({
            while: (error) =>
              error instanceof InstanceStateMismatch ||
              isPendingInstanceLookupError(error),
            schedule: Schedule.exponential("250 millis").pipe(
              Schedule.both(Schedule.recurs(8)),
            ),
          }),
        );
      });

      const waitForDeleted = Effect.fn(function* ({
        instanceId,
        session,
      }: {
        instanceId: string;
        session: Pick<ScopedPlanStatusSession, "note">;
      }) {
        yield* describeInstance(instanceId).pipe(
          Effect.tap((instance) =>
            session.note(
              `Waiting for instance deletion ${instanceId}: ${instance.State?.Name ?? "unknown"}`,
            ),
          ),
          Effect.flatMap((instance) =>
            instance.State?.Name === "terminated"
              ? Effect.succeed(undefined)
              : Effect.fail(new InstanceStillExists({ instanceId })),
          ),
          Effect.retry({
            while: (error) => error instanceof InstanceStillExists,
            schedule: Schedule.exponential("250 millis").pipe(
              Schedule.both(Schedule.recurs(8)),
            ),
          }),
          Effect.catchTag("InvalidInstanceID.NotFound", () => Effect.void),
          Effect.catchTag("InstanceNotFound", () => Effect.void),
        );
      });

      const resolvedSecurityGroups = (
        groups?: InstanceProps["securityGroupIds"],
      ) => hosted.normalizeSecurityGroups(groups as string[] | undefined);

      const buildRunInstancesRequest = (
        news: InstanceProps,
        runtime: {
          userData?: string;
          instanceProfileName?: string;
        },
        tags: Record<string, string>,
      ): ec2.RunInstancesRequest => {
        return {
          ...hosted.buildLaunchTemplateData(
            {
              imageId: news.imageId,
              instanceType: news.instanceType,
              keyName: news.keyName,
              subnetId: news.subnetId as string | undefined,
              securityGroupIds: news.securityGroupIds as string[] | undefined,
              associatePublicIpAddress: news.associatePublicIpAddress,
              privateIpAddress: news.privateIpAddress,
              availabilityZone: news.availabilityZone,
              tags,
            },
            runtime,
          ),
          MinCount: 1,
          MaxCount: 1,
        };
      };

      return {
        stables: ["instanceId", "instanceArn", "vpcId", "subnetId"],
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          const hostModeChanged = Boolean(olds.main) !== Boolean(news.main);
          if (
            hostModeChanged ||
            olds.imageId !== news.imageId ||
            olds.subnetId !== news.subnetId ||
            olds.keyName !== news.keyName ||
            olds.instanceProfileName !== news.instanceProfileName ||
            olds.userData !== news.userData ||
            olds.associatePublicIpAddress !== news.associatePublicIpAddress ||
            olds.privateIpAddress !== news.privateIpAddress ||
            olds.availabilityZone !== news.availabilityZone
          ) {
            return { action: "replace" } as const;
          }

          if (
            olds.instanceType !== news.instanceType ||
            olds.sourceDestCheck !== news.sourceDestCheck ||
            olds.main !== news.main ||
            olds.handler !== news.handler ||
            olds.port !== news.port ||
            !deepEqual(olds.env ?? {}, news.env ?? {}) ||
            !deepEqual(olds.build ?? {}, news.build ?? {}) ||
            !deepEqual(
              olds.roleManagedPolicyArns ?? [],
              news.roleManagedPolicyArns ?? [],
            ) ||
            !deepEqual(
              resolvedSecurityGroups(olds.securityGroupIds),
              resolvedSecurityGroups(news.securityGroupIds),
            ) ||
            !deepEqual(olds.tags ?? {}, news.tags ?? {})
          ) {
            return {
              action: "update",
              stables: ["instanceId", "instanceArn", "vpcId", "subnetId"],
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, output }) {
          const instance = output?.instanceId
            ? yield* describeInstance(output.instanceId).pipe(
                Effect.catchTag("InvalidInstanceID.NotFound", () =>
                  Effect.succeed(undefined),
                ),
                Effect.catchTag("InstanceNotFound", () =>
                  Effect.succeed(undefined),
                ),
              )
            : yield* findInstanceByTags(id);
          return instance
            ? {
                ...toAttributes(instance),
                instanceProfileName: output?.instanceProfileName,
                roleArn: output?.roleArn,
                roleName: output?.roleName,
                policyName: output?.policyName,
                managedIam: output?.managedIam,
                runtimeUnitName: output?.runtimeUnitName,
                assetPrefix: output?.assetPrefix,
                code: output?.code,
              }
            : undefined;
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          const desiredTags = {
            ...(yield* createInternalTags(id)),
            ...news.tags,
          };
          const runtime = yield* hosted.resolveHostedRuntime({
            id,
            news,
            bindings,
            output,
          });

          // Observe — try the cached instanceId first, then fall back to the
          // alchemy-tag search for recovery from interrupted creates. EC2
          // assigns instance IDs server-side so we always read the live
          // record before deciding whether to launch a new one.
          let instance: ec2.Instance | undefined = output?.instanceId
            ? yield* describeInstance(output.instanceId).pipe(
                Effect.catchTag("InvalidInstanceID.NotFound", () =>
                  Effect.succeed(undefined),
                ),
                Effect.catchTag("InstanceNotFound", () =>
                  Effect.succeed(undefined),
                ),
              )
            : yield* findInstanceByTags(id);

          // A terminated instance is a tombstone; treat as missing so we
          // launch a fresh one.
          if (instance && instance.State?.Name === "terminated") {
            instance = undefined;
          }

          // Ensure — RunInstances when no live instance was observed. The
          // initial sourceDestCheck is set here because RunInstances itself
          // doesn't accept it.
          if (instance === undefined) {
            const created = yield* ec2
              .runInstances(
                buildRunInstancesRequest(news, runtime, desiredTags),
              )
              .pipe(
                Effect.retry({
                  while: isPendingInstanceProfileError,
                  schedule: Schedule.exponential("500 millis").pipe(
                    Schedule.both(Schedule.recurs(8)),
                  ),
                }),
              );
            const newInstanceId = created.Instances?.[0]?.InstanceId as
              | InstanceId
              | undefined;
            if (!newInstanceId) {
              return yield* Effect.fail(
                new Error(`RunInstances returned no instance ID for '${id}'`),
              );
            }
            yield* session.note(newInstanceId);
            instance = yield* waitForState({
              instanceId: newInstanceId,
              states: ["running"],
              session,
            });
            if (news.sourceDestCheck !== undefined) {
              yield* ec2.modifyInstanceAttribute({
                InstanceId: newInstanceId,
                SourceDestCheck: { Value: news.sourceDestCheck },
              });
            }
          }

          const instanceId = instance.InstanceId as InstanceId;
          let restarted = false;

          // Sync security groups — observed primary-ENI groups vs desired.
          const observedSecurityGroups = (instance.SecurityGroups ?? [])
            .map((g) => g.GroupId)
            .filter((g): g is string => Boolean(g));
          const desiredSecurityGroups = resolvedSecurityGroups(
            news.securityGroupIds,
          );
          if (
            desiredSecurityGroups &&
            JSON.stringify([...observedSecurityGroups].sort()) !==
              JSON.stringify([...desiredSecurityGroups].sort())
          ) {
            yield* ec2.modifyInstanceAttribute({
              InstanceId: instanceId,
              Groups: desiredSecurityGroups,
            });
          }

          // Sync source/dest check — observed flag vs desired (default true).
          const desiredSourceDestCheck = news.sourceDestCheck ?? true;
          if ((instance.SourceDestCheck ?? true) !== desiredSourceDestCheck) {
            yield* ec2.modifyInstanceAttribute({
              InstanceId: instanceId,
              SourceDestCheck: { Value: desiredSourceDestCheck },
            });
          }

          // Sync instance type — observed type vs desired. Type changes need
          // the instance stopped, then we restart it if it was running.
          if (
            news.instanceType &&
            String(instance.InstanceType ?? "") !== news.instanceType
          ) {
            const wasRunning = instance.State?.Name === "running";
            if (wasRunning) {
              yield* ec2.stopInstances({ InstanceIds: [instanceId] });
              yield* waitForState({
                instanceId,
                states: ["stopped"],
                session,
              });
            }
            yield* ec2.modifyInstanceAttribute({
              InstanceId: instanceId,
              InstanceType: {
                Value: news.instanceType as ec2.InstanceType,
              },
            });
            if (wasRunning) {
              yield* ec2.startInstances({ InstanceIds: [instanceId] });
              yield* waitForState({
                instanceId,
                states: ["running"],
                session,
              });
              restarted = true;
            }
          }

          // Sync tags — observed cloud tags vs desired.
          const currentTags = Object.fromEntries(
            (instance.Tags ?? [])
              .filter((t): t is { Key: string; Value: string } =>
                Boolean(t.Key && t.Value !== undefined),
              )
              .map((t) => [t.Key, t.Value]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [instanceId],
              Tags: removed.map((key) => ({ Key: key })),
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [instanceId],
              Tags: upsert,
            });
          }

          // Hosted-runtime reboot — picks up new bundle/env without an
          // explicit instance-type cycle. Skip if the type-change path
          // already restarted us.
          if (news.main && !restarted) {
            yield* ec2.rebootInstances({ InstanceIds: [instanceId] });
            yield* waitForState({
              instanceId,
              states: ["running"],
              session,
            });
          }

          // Re-read final state so attributes reflect the post-sync cloud.
          const final = yield* describeInstance(instanceId);
          return {
            ...toAttributes(final),
            instanceProfileName:
              runtime.instanceProfileName ?? output?.instanceProfileName,
            roleArn: runtime.roleArn ?? output?.roleArn,
            roleName: runtime.roleName ?? output?.roleName,
            policyName: runtime.policyName ?? output?.policyName,
            managedIam: runtime.managedIam ?? output?.managedIam,
            runtimeUnitName: runtime.runtimeUnitName ?? output?.runtimeUnitName,
            assetPrefix: runtime.assetPrefix ?? output?.assetPrefix,
            code: runtime.code ?? output?.code,
          };
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ec2
            .terminateInstances({
              InstanceIds: [output.instanceId],
            })
            .pipe(
              Effect.catchTag("InvalidInstanceID.NotFound", () => Effect.void),
            );
          yield* waitForDeleted({
            instanceId: output.instanceId,
            session,
          });

          yield* hosted.cleanupHostedRuntime({ output });
        }),
      };
    }),
  );

class InstanceNotFound extends Data.TaggedError("InstanceNotFound")<{
  instanceId: string;
}> {}

class InstanceStillExists extends Data.TaggedError("InstanceStillExists")<{
  instanceId: string;
}> {}

class InstanceStateMismatch extends Data.TaggedError("InstanceStateMismatch")<{
  instanceId: string;
  actual: string;
  expected: string[];
}> {}
