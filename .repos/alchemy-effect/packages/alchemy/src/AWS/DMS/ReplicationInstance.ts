import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface ReplicationInstanceProps {
  /**
   * Replication-instance identifier. Must be lowercase, 1-63 characters,
   * begin with a letter, and contain only letters, digits, and hyphens. If
   * omitted, a deterministic physical name is generated. Changing it replaces
   * the instance.
   */
  replicationInstanceIdentifier?: string;
  /**
   * Compute and memory class, e.g. `"dms.t3.micro"`, `"dms.c5.large"`.
   */
  replicationInstanceClass: string;
  /**
   * Storage in gigabytes allocated to the replication instance.
   * @default service-chosen for the instance class
   */
  allocatedStorage?: number;
  /**
   * VPC security group IDs controlling network access to the instance.
   */
  vpcSecurityGroupIds?: string[];
  /**
   * Availability Zone the instance is created in. Changing it replaces the
   * instance.
   */
  availabilityZone?: string;
  /**
   * Subnet group the instance is placed in. Changing it replaces the
   * instance.
   */
  replicationSubnetGroupIdentifier?: string;
  /**
   * Weekly maintenance window in `ddd:hh24:mi-ddd:hh24:mi` (UTC) format.
   */
  preferredMaintenanceWindow?: string;
  /**
   * Whether to provision the instance across multiple Availability Zones.
   * @default false
   */
  multiAZ?: boolean;
  /**
   * DMS engine version.
   * @default latest
   */
  engineVersion?: string;
  /**
   * Whether minor engine upgrades are applied automatically during the
   * maintenance window.
   * @default true
   */
  autoMinorVersionUpgrade?: boolean;
  /**
   * Customer-managed KMS key for storage encryption. Changing it replaces the
   * instance.
   * @default AWS-owned DMS key
   */
  kmsKeyId?: string;
  /**
   * Whether the instance gets a public IP address. Changing it replaces the
   * instance.
   * @default true
   */
  publiclyAccessible?: boolean;
  /**
   * Network type: `"IPV4"`, `"IPV6"`, or `"DUAL"`. Changing it replaces the
   * instance.
   */
  networkType?: string;
  /**
   * User-defined tags for the instance.
   */
  tags?: Record<string, string>;
}

export interface ReplicationInstance extends Resource<
  "AWS.DMS.ReplicationInstance",
  ReplicationInstanceProps,
  {
    /** The replication instance identifier (unique per account/region). */
    replicationInstanceIdentifier: string;
    /** The ARN of the replication instance. */
    replicationInstanceArn: string;
    /** The compute class of the instance, e.g. `dms.t3.micro`. */
    replicationInstanceClass: string;
    /** The current status of the instance, e.g. `available`. */
    status: string | undefined;
    /** The DMS engine version running on the instance. */
    engineVersion: string | undefined;
    /** The private IP addresses of the instance. */
    privateIpAddresses: string[];
    /** The public IP addresses of the instance (when publicly accessible). */
    publicIpAddresses: string[];
    /** The tags attached to the replication instance. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DMS replication instance — the managed compute that runs migration and
 * replication tasks. Provisioning takes several minutes and the instance is
 * billed hourly while it exists, so create it only when a migration is
 * running and destroy it promptly.
 * @resource
 * @section Creating a Replication Instance
 * @example Small Instance in a Subnet Group
 * ```typescript
 * const instance = yield* ReplicationInstance("Migration", {
 *   replicationInstanceClass: "dms.t3.micro",
 *   allocatedStorage: 50,
 *   replicationSubnetGroupIdentifier: subnetGroup.replicationSubnetGroupIdentifier,
 *   publiclyAccessible: false,
 * });
 * ```
 */
export const ReplicationInstance = Resource<ReplicationInstance>(
  "AWS.DMS.ReplicationInstance",
);

const toTagRecord = (
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (tags ?? [])
      .filter(
        (tag): tag is { Key: string; Value: string } =>
          typeof tag.Key === "string" && typeof tag.Value === "string",
      )
      .map((tag) => [tag.Key, tag.Value]),
  );

export const ReplicationInstanceProvider = () =>
  Provider.effect(
    ReplicationInstance,
    Effect.gen(function* () {
      const toName = (id: string, props: ReplicationInstanceProps) =>
        props.replicationInstanceIdentifier
          ? Effect.succeed(props.replicationInstanceIdentifier)
          : createPhysicalName({ id, maxLength: 60, lowercase: true });

      const findInstance = Effect.fn(function* (identifier: string) {
        const response = yield* dms
          .describeReplicationInstances({
            Filters: [
              { Name: "replication-instance-id", Values: [identifier] },
            ],
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ReplicationInstances?.[0];
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* dms
          .listTagsForResource({ ResourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return toTagRecord(response?.TagList);
      });

      // Provisioning and modifications both surface as a transitional status;
      // budget ~15 minutes (15s x 60) for the instance to become available.
      const waitForInstance = Effect.fn(function* (identifier: string) {
        const readinessPolicy = Schedule.max([
          Schedule.fixed("15 seconds"),
          Schedule.recurs(60),
        ]);
        return yield* findInstance(identifier).pipe(
          Effect.flatMap((instance) => {
            if (!instance?.ReplicationInstanceArn) {
              return Effect.fail(
                new Error(`DMS replication instance '${identifier}' not found`),
              );
            }
            if (instance.ReplicationInstanceStatus !== "available") {
              return Effect.fail(
                new Error(
                  `DMS replication instance '${identifier}' not available (status: ${instance.ReplicationInstanceStatus})`,
                ),
              );
            }
            return Effect.succeed(instance);
          }),
          Effect.retry({ schedule: readinessPolicy }),
        );
      });

      const toAttrs = Effect.fn(function* (instance: dms.ReplicationInstance) {
        const identifier = instance.ReplicationInstanceIdentifier;
        if (!identifier || !instance.ReplicationInstanceArn) {
          return yield* Effect.fail(
            new Error(
              `DMS replication instance '${identifier}' is missing its identifier or ARN`,
            ),
          );
        }
        return {
          replicationInstanceIdentifier: identifier,
          replicationInstanceArn: instance.ReplicationInstanceArn,
          replicationInstanceClass: instance.ReplicationInstanceClass ?? "",
          status: instance.ReplicationInstanceStatus,
          engineVersion: instance.EngineVersion,
          privateIpAddresses: [
            ...(instance.ReplicationInstancePrivateIpAddresses ?? []),
          ],
          publicIpAddresses: [
            ...(instance.ReplicationInstancePublicIpAddresses ?? []),
          ],
          tags: yield* readTags(instance.ReplicationInstanceArn),
        };
      });

      return {
        stables: ["replicationInstanceIdentifier", "replicationInstanceArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(
              id,
              olds ??
                ({
                  replicationInstanceClass: "",
                } as ReplicationInstanceProps),
            )) !== (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
          // Create-only properties force a replacement.
          if (
            (news.publiclyAccessible ?? undefined) !==
            (olds?.publiclyAccessible ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if ((news.kmsKeyId ?? undefined) !== (olds?.kmsKeyId ?? undefined)) {
            return { action: "replace" } as const;
          }
          if (
            (news.availabilityZone ?? undefined) !==
            (olds?.availabilityZone ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (news.replicationSubnetGroupIdentifier ?? undefined) !==
            (olds?.replicationSubnetGroupIdentifier ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          if (
            (news.networkType ?? undefined) !== (olds?.networkType ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.replicationInstanceIdentifier ??
            (yield* toName(
              id,
              olds ??
                ({
                  replicationInstanceClass: "",
                } as ReplicationInstanceProps),
            ));
          const instance = yield* findInstance(name);
          if (!instance?.ReplicationInstanceArn) return undefined;
          const attrs = yield* toAttrs(instance);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.replicationInstanceIdentifier ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* findInstance(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* dms
              .createReplicationInstance({
                ReplicationInstanceIdentifier: name,
                ReplicationInstanceClass: news.replicationInstanceClass,
                AllocatedStorage: news.allocatedStorage,
                VpcSecurityGroupIds: news.vpcSecurityGroupIds,
                AvailabilityZone: news.availabilityZone,
                ReplicationSubnetGroupIdentifier:
                  news.replicationSubnetGroupIdentifier,
                PreferredMaintenanceWindow: news.preferredMaintenanceWindow,
                MultiAZ: news.multiAZ,
                EngineVersion: news.engineVersion,
                AutoMinorVersionUpgrade: news.autoMinorVersionUpgrade,
                KmsKeyId: news.kmsKeyId,
                PubliclyAccessible: news.publiclyAccessible,
                NetworkType: news.networkType,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                Effect.catchTag(
                  "ResourceAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
          }

          // Wait for availability so sync/modify calls don't hit
          // InvalidResourceStateFault.
          observed = yield* waitForInstance(name);

          // 3. Sync — compute the modify delta from OBSERVED state. Immutable
          //    properties are handled by diff (replacement), so only mutable
          //    aspects are compared here.
          const modify: dms.ModifyReplicationInstanceMessage = {
            ReplicationInstanceArn: observed.ReplicationInstanceArn!,
            ApplyImmediately: true,
          };
          let dirty = false;
          if (
            news.replicationInstanceClass !== observed.ReplicationInstanceClass
          ) {
            modify.ReplicationInstanceClass = news.replicationInstanceClass;
            dirty = true;
          }
          if (
            news.allocatedStorage !== undefined &&
            news.allocatedStorage !== observed.AllocatedStorage
          ) {
            modify.AllocatedStorage = news.allocatedStorage;
            dirty = true;
          }
          if (news.multiAZ !== undefined && news.multiAZ !== observed.MultiAZ) {
            modify.MultiAZ = news.multiAZ;
            dirty = true;
          }
          if (
            news.engineVersion !== undefined &&
            news.engineVersion !== observed.EngineVersion
          ) {
            modify.EngineVersion = news.engineVersion;
            modify.AllowMajorVersionUpgrade = true;
            dirty = true;
          }
          if (
            news.preferredMaintenanceWindow !== undefined &&
            news.preferredMaintenanceWindow !==
              observed.PreferredMaintenanceWindow
          ) {
            modify.PreferredMaintenanceWindow = news.preferredMaintenanceWindow;
            dirty = true;
          }

          if (dirty) {
            yield* dms.modifyReplicationInstance(modify);
            observed = yield* waitForInstance(name);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = observed.ReplicationInstanceArn!;
          const observedTags = yield* readTags(arn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* dms.addTagsToResource({ ResourceArn: arn, Tags: upsert });
          }
          if (removed.length > 0) {
            yield* dms.removeTagsFromResource({
              ResourceArn: arn,
              TagKeys: removed,
            });
          }

          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          // Deletion of an instance mid-create/modify is rejected with
          // InvalidResourceStateFault — deletion is already impossible until it
          // settles, so treat that (and NotFound) as success/in-progress.
          yield* dms
            .deleteReplicationInstance({
              ReplicationInstanceArn: output.replicationInstanceArn,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundFault", () => Effect.void),
              Effect.catchTag("InvalidResourceStateFault", () => Effect.void),
            );
        }),

        list: () =>
          dms.describeReplicationInstances.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ReplicationInstances ?? []).filter(
                  (instance) =>
                    instance.ReplicationInstanceIdentifier !== undefined &&
                    instance.ReplicationInstanceArn !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((instance) => toAttrs(instance), {
                concurrency: 4,
              }),
            ),
          ),
      };
    }),
  );
