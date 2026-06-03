import type { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { createInternalTags, diffTags, hasTags } from "../../Tags.ts";
import { Assets } from "../Assets.ts";
import type { SecurityGroupId } from "../EC2/SecurityGroup.ts";
import {
  createEc2HostRuntimeContext,
  createEc2HostedSupport,
  type Ec2HostRuntimeContext,
} from "../EC2/hosted.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { PolicyStatement } from "../IAM/Policy.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";

export type LaunchTemplateId = `lt-${string}`;
export type LaunchTemplateName = string;
export type LaunchTemplateArn =
  `arn:aws:ec2:${RegionID}:${AccountID}:launch-template/${LaunchTemplateId}`;

export interface LaunchTemplateProps extends PlatformProps {
  /**
   * Launch template name. If omitted, a deterministic name is generated.
   */
  launchTemplateName?: string;
  /**
   * AMI ID to launch.
   */
  imageId: string;
  /**
   * EC2 instance type, such as `t3.micro`.
   */
  instanceType: string;
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
   * User-defined tags to apply to the launch template and launched instances.
   */
  tags?: Record<string, string>;
  /**
   * Module entrypoint for the bundled instance program.
   * When omitted, the launch template behaves as a low-level EC2 primitive.
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

export interface LaunchTemplate extends Resource<
  "AWS.AutoScaling.LaunchTemplate",
  LaunchTemplateProps,
  {
    launchTemplateId: LaunchTemplateId;
    launchTemplateArn: LaunchTemplateArn;
    launchTemplateName: LaunchTemplateName;
    defaultVersionNumber: number;
    latestVersionNumber: number;
    tags: Record<string, string>;
    roleArn?: string;
    roleName?: string;
    policyName?: string;
    managedIam?: boolean;
    runtimeUnitName?: string;
    assetPrefix?: string;
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

export type LaunchTemplateServices = Credentials | Region;

export type LaunchTemplateShape = Main<LaunchTemplateServices>;

export type LaunchTemplateRuntimeContext = Ec2HostRuntimeContext;

/**
 * A launch template that preserves the `Host` authoring model used by
 * `AWS.EC2.Instance`, but packages that host configuration for use with an
 * Auto Scaling Group.
 *
 * @section Hosting Processes
 * @example Hosted HTTP Launch Template
 * ```typescript
 * const template = yield* Effect.gen(function* () {
 *   yield* Http.serve(HttpServerResponse.json({ ok: true }));
 *
 *   return {
 *     main: import.meta.filename,
 *     imageId,
 *     instanceType: "t3.small",
 *     securityGroupIds: [securityGroup.groupId],
 *     port: 3000,
 *   };
 * }).pipe(
 *   Effect.provide(AWS.EC2.HttpServer),
 *   AWS.AutoScaling.LaunchTemplate("ApiTemplate"),
 * );
 * ```
 */
export const LaunchTemplate: Platform<
  LaunchTemplate,
  LaunchTemplateServices,
  LaunchTemplateShape,
  LaunchTemplateRuntimeContext
> = Platform("AWS.AutoScaling.LaunchTemplate", {
  createRuntimeContext: createEc2HostRuntimeContext(
    "AWS.AutoScaling.LaunchTemplate",
  ),
});

export const LaunchTemplateProvider = () =>
  Provider.effect(
    LaunchTemplate,
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment;
      const region = yield* Region;
      const stack = yield* Stack;
      const stage = yield* Stage;
      const fs = yield* FileSystem.FileSystem;
      const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
      const assets = (yield* Effect.serviceOption(Assets)).pipe(
        Option.getOrUndefined,
      );

      const hosted = createEc2HostedSupport({
        accountId,
        region,
        stackName: stack.name,
        stage,
        fs,
        virtualEntryPlugin,
        assets,
        resourceType: "AWS.AutoScaling.LaunchTemplate",
      });

      const toName = (
        id: string,
        props: { launchTemplateName?: string } = {},
      ) =>
        props.launchTemplateName
          ? Effect.succeed(props.launchTemplateName)
          : createPhysicalName({ id, maxLength: 128, lowercase: true });

      const toArn = (launchTemplateId: LaunchTemplateId) =>
        `arn:aws:ec2:${region}:${accountId}:launch-template/${launchTemplateId}` as LaunchTemplateArn;

      const describeById = (launchTemplateId: string) =>
        ec2
          .describeLaunchTemplates({
            LaunchTemplateIds: [launchTemplateId],
          } as any)
          .pipe(
            Effect.map((result) => result.LaunchTemplates?.[0]),
            Effect.catch((error) =>
              isLaunchTemplateNotFound(error)
                ? Effect.succeed(undefined)
                : Effect.fail(error),
            ),
          );

      const describeByName = (launchTemplateName: string) =>
        ec2
          .describeLaunchTemplates({
            LaunchTemplateNames: [launchTemplateName],
          } as any)
          .pipe(
            Effect.map((result) => result.LaunchTemplates?.[0]),
            Effect.catch((error) =>
              isLaunchTemplateNotFound(error)
                ? Effect.succeed(undefined)
                : Effect.fail(error),
            ),
          );

      const syncTemplateTags = Effect.fn(function* ({
        launchTemplateId,
        oldTags,
        newTags,
      }: {
        launchTemplateId: LaunchTemplateId;
        oldTags: Record<string, string>;
        newTags: Record<string, string>;
      }) {
        const { removed, upsert } = diffTags(oldTags, newTags);
        if (removed.length > 0) {
          yield* ec2.deleteTags({
            Resources: [launchTemplateId],
            Tags: removed.map((key) => ({ Key: key })),
          });
        }
        if (upsert.length > 0) {
          yield* ec2.createTags({
            Resources: [launchTemplateId],
            Tags: upsert,
          });
        }
      });

      const createVersion = Effect.fn(function* ({
        launchTemplateId,
        news,
        runtime,
      }: {
        launchTemplateId: LaunchTemplateId;
        news: LaunchTemplateProps;
        runtime: {
          userData?: string;
          instanceProfileName?: string;
          code?: {
            hash: string;
          };
        };
      }) {
        const created = yield* ec2.createLaunchTemplateVersion({
          LaunchTemplateId: launchTemplateId,
          VersionDescription: runtime.code?.hash ?? "alchemy-update",
          LaunchTemplateData: hosted.buildLaunchTemplateData(
            {
              imageId: news.imageId,
              instanceType: news.instanceType,
              keyName: news.keyName,
              securityGroupIds: news.securityGroupIds as string[] | undefined,
              associatePublicIpAddress: news.associatePublicIpAddress,
              tags: news.tags,
            },
            runtime,
          ),
        } as any);

        const versionNumber = created.LaunchTemplateVersion?.VersionNumber;
        if (versionNumber === undefined) {
          return yield* Effect.fail(
            new Error(
              `createLaunchTemplateVersion returned no version for '${launchTemplateId}'`,
            ),
          );
        }

        yield* ec2.modifyLaunchTemplate({
          LaunchTemplateId: launchTemplateId,
          DefaultVersion: String(versionNumber),
        } as any);

        return Number(versionNumber);
      });

      const toAttributes = (
        template: ec2.LaunchTemplate,
        runtime: Partial<LaunchTemplate["Attributes"]> = {},
      ): LaunchTemplate["Attributes"] => ({
        launchTemplateId: template.LaunchTemplateId as LaunchTemplateId,
        launchTemplateArn: toArn(template.LaunchTemplateId as LaunchTemplateId),
        launchTemplateName: template.LaunchTemplateName!,
        defaultVersionNumber: Number(template.DefaultVersionNumber ?? 1),
        latestVersionNumber: Number(
          template.LatestVersionNumber ?? template.DefaultVersionNumber ?? 1,
        ),
        tags: toTagRecord(template.Tags),
        roleArn: runtime.roleArn,
        roleName: runtime.roleName,
        policyName: runtime.policyName,
        managedIam: runtime.managedIam,
        runtimeUnitName: runtime.runtimeUnitName,
        assetPrefix: runtime.assetPrefix,
        code: runtime.code,
      });

      return {
        stables: [
          "launchTemplateId",
          "launchTemplateArn",
          "launchTemplateName",
        ],
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }

          if (!deepEqual(olds, news)) {
            return {
              action: "update",
              stables: [
                "launchTemplateId",
                "launchTemplateArn",
                "launchTemplateName",
              ],
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const template =
            (output?.launchTemplateId &&
              (yield* describeById(output.launchTemplateId))) ??
            (yield* describeByName(yield* toName(id, olds ?? {})));

          return template
            ? toAttributes(template, {
                roleArn: output?.roleArn,
                roleName: output?.roleName,
                policyName: output?.policyName,
                managedIam: output?.managedIam,
                runtimeUnitName: output?.runtimeUnitName,
                assetPrefix: output?.assetPrefix,
                code: output?.code,
              })
            : undefined;
        }),
        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          const launchTemplateName =
            output?.launchTemplateName ?? (yield* toName(id, news));
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

          // Observe — fetch live cloud state. We try both lookup paths
          // (id from output, name from desired) so the reconciler
          // converges whether `output` is fresh, stale, or missing.
          let existing =
            (output?.launchTemplateId &&
              (yield* describeById(output.launchTemplateId))) ||
            (yield* describeByName(launchTemplateName));

          // Ensure — create the launch template if missing. We must
          // verify alchemy ownership via tags here (since this resource
          // does not implement `read` adoption gating).
          if (!existing) {
            const created = yield* ec2.createLaunchTemplate({
              LaunchTemplateName: launchTemplateName,
              VersionDescription: runtime.code?.hash ?? "alchemy-create",
              TagSpecifications: [
                {
                  ResourceType: "launch-template",
                  Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                    Key,
                    Value,
                  })),
                },
              ],
              LaunchTemplateData: hosted.buildLaunchTemplateData(
                {
                  imageId: news.imageId,
                  instanceType: news.instanceType,
                  keyName: news.keyName,
                  securityGroupIds: news.securityGroupIds as
                    | string[]
                    | undefined,
                  associatePublicIpAddress: news.associatePublicIpAddress,
                  tags: desiredTags,
                },
                runtime,
              ),
            } as any);
            const template = created.LaunchTemplate;
            if (!template?.LaunchTemplateId || !template.LaunchTemplateName) {
              return yield* Effect.fail(
                new Error(
                  `createLaunchTemplate returned no launch template for '${id}'`,
                ),
              );
            }
            yield* session.note(template.LaunchTemplateId);
            return toAttributes(template as ec2.LaunchTemplate, runtime);
          }

          if (!hasTags(desiredTags, toTagRecord(existing.Tags))) {
            return yield* Effect.fail(
              new Error(
                `Launch template '${launchTemplateName}' already exists and is not managed by alchemy`,
              ),
            );
          }

          // Sync version — each reconcile creates a new version pinned as
          // the default. ASGs that reference `$Default` automatically
          // pick up the new version.
          yield* createVersion({
            launchTemplateId: existing.LaunchTemplateId as LaunchTemplateId,
            news,
            runtime,
          });

          // Sync tags — diff observed cloud tags against desired.
          yield* syncTemplateTags({
            launchTemplateId: existing.LaunchTemplateId as LaunchTemplateId,
            oldTags: toTagRecord(existing.Tags),
            newTags: desiredTags,
          });

          const refreshed = yield* describeById(existing.LaunchTemplateId!);
          if (!refreshed) {
            return yield* Effect.fail(
              new Error(
                `Launch template '${launchTemplateName}' was not readable after reconcile`,
              ),
            );
          }
          yield* session.note(refreshed.LaunchTemplateId!);
          return toAttributes(refreshed, runtime);
        }),
        delete: Effect.fn(function* ({ output, session }) {
          yield* ec2
            .deleteLaunchTemplate({
              LaunchTemplateId: output.launchTemplateId,
            } as any)
            .pipe(
              Effect.catch((error) =>
                isLaunchTemplateNotFound(error)
                  ? Effect.void
                  : Effect.fail(error),
              ),
            );

          yield* hosted.cleanupHostedRuntime({ output, session });
        }),
      };
    }),
  );

const isLaunchTemplateNotFound = (error: unknown) => {
  const tag = (error as { _tag?: string })?._tag;
  return (
    tag === "InvalidLaunchTemplateNameNotFoundException" ||
    tag === "InvalidLaunchTemplateIdNotFoundException" ||
    tag === "InvalidLaunchTemplateId.Malformed" ||
    tag === "InvalidLaunchTemplateId.NotFound"
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
