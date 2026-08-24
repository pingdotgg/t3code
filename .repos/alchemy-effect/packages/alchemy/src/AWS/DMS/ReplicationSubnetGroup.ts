import * as dms from "@distilled.cloud/aws/database-migration-service";
import * as iam from "@distilled.cloud/aws/iam";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ReplicationSubnetGroupProps {
  /**
   * Subnet-group identifier. Must be lowercase, 1-255 characters, and cannot
   * be the reserved value `default`. If omitted, a deterministic physical
   * name is generated. Changing it replaces the subnet group.
   */
  replicationSubnetGroupIdentifier?: string;
  /**
   * Human-readable description of the subnet group.
   */
  description?: string;
  /**
   * VPC subnet IDs the replication instance can be placed in. Must span at
   * least two Availability Zones.
   */
  subnetIds: string[];
  /**
   * User-defined tags for the subnet group.
   */
  tags?: Record<string, string>;
}

export interface ReplicationSubnetGroup extends Resource<
  "AWS.DMS.ReplicationSubnetGroup",
  ReplicationSubnetGroupProps,
  {
    /** The subnet group identifier (unique per account/region). */
    replicationSubnetGroupIdentifier: string;
    /** The ARN of the replication subnet group. */
    replicationSubnetGroupArn: string;
    /** The VPC the subnets belong to. */
    vpcId: string | undefined;
    /** The IDs of the subnets in the group. */
    subnetIds: string[];
    /** The current status of the subnet group, e.g. `Complete`. */
    status: string | undefined;
    /** The tags attached to the subnet group. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DMS replication subnet group — the set of VPC subnets a replication
 * instance can be launched into. Must cover at least two Availability Zones.
 * Free and fast to create.
 * @resource
 * @section Creating a Subnet Group
 * @example Two-AZ Subnet Group
 * ```typescript
 * const subnetGroup = yield* ReplicationSubnetGroup("Migration", {
 *   description: "DMS replication subnets",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * ```
 */
export const ReplicationSubnetGroup = Resource<ReplicationSubnetGroup>(
  "AWS.DMS.ReplicationSubnetGroup",
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

const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

const DMS_VPC_ROLE_NAME = "dms-vpc-role";
const DMS_VPC_POLICY_ARN =
  "arn:aws:iam::aws:policy/service-role/AmazonDMSVPCManagementRole";
const DMS_VPC_ROLE_OWNER_TAG = {
  Key: "alchemy::managed-by",
  Value: "AWS.DMS.ReplicationSubnetGroup",
} as const;

export const ReplicationSubnetGroupProvider = () =>
  Provider.effect(
    ReplicationSubnetGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: ReplicationSubnetGroupProps) =>
        props.replicationSubnetGroupIdentifier
          ? Effect.succeed(props.replicationSubnetGroupIdentifier)
          : createPhysicalName({ id, maxLength: 200, lowercase: true });

      // Subnet-group ARNs deterministically embed the identifier, so we build
      // them rather than reading one back (describe returns no ARN).
      const toArn = Effect.fn(function* (identifier: string) {
        const { accountId, region } = yield* AWSEnvironment.current;
        return `arn:aws:dms:${region}:${accountId}:subgrp:${identifier}`;
      });

      const findGroup = Effect.fn(function* (identifier: string) {
        const response = yield* dms
          .describeReplicationSubnetGroups({
            Filters: [
              { Name: "replication-subnet-group-id", Values: [identifier] },
            ],
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundFault", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ReplicationSubnetGroups?.[0];
      });

      // DMS requires the account-wide `dms-vpc-role` (trusting
      // dms.amazonaws.com with the AmazonDMSVPCManagementRole managed policy)
      // before any VPC-touching operation. The console creates it implicitly;
      // API callers must ensure it. Tag only roles created by this provider so
      // deletion can distinguish our helper from pre-existing account
      // infrastructure with the same AWS-mandated name.
      const ensureDmsVpcRole = Effect.gen(function* () {
        yield* iam
          .createRole({
            RoleName: DMS_VPC_ROLE_NAME,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "dms.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Tags: [DMS_VPC_ROLE_OWNER_TAG],
          })
          .pipe(
            Effect.catchTag("EntityAlreadyExistsException", () => Effect.void),
          );
        // Idempotent — attaching an already-attached managed policy is a no-op.
        yield* iam.attachRolePolicy({
          RoleName: DMS_VPC_ROLE_NAME,
          PolicyArn: DMS_VPC_POLICY_ARN,
        });
      }).pipe(
        // A concurrent last-subnet-group delete can remove the shared helper
        // between create/get and policy attachment. Re-observe and ensure it
        // again instead of surfacing a cross-test race.
        Effect.retry({
          while: (error) =>
            error._tag === "NoSuchEntityException" ||
            error._tag === "ConcurrentModificationException" ||
            error._tag === "LimitExceededException" ||
            error._tag === "ServiceFailureException",
          schedule: Schedule.max([
            Schedule.fixed("1 second"),
            Schedule.recurs(10),
          ]),
        }),
      );

      const deleteOwnedDmsVpcRoleIfUnused = Effect.gen(function* () {
        // Bound the whole observe/detach/delete loop to 30 seconds. Every pass
        // rechecks DMS first, so a concurrent subnet-group create protects the
        // role and takes responsibility for deleting it later.
        for (let attempt = 0; attempt < 30; attempt++) {
          const groups = yield* dms.describeReplicationSubnetGroups({});
          if ((groups.ReplicationSubnetGroups ?? []).length > 0) return;

          const tags = yield* iam
            .listRoleTags({ RoleName: DMS_VPC_ROLE_NAME })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (tags === undefined) return;
          const owned = (tags.Tags ?? []).some(
            (tag) =>
              tag.Key === DMS_VPC_ROLE_OWNER_TAG.Key &&
              tag.Value === DMS_VPC_ROLE_OWNER_TAG.Value,
          );
          if (!owned) return;

          const deleted = yield* Effect.gen(function* () {
            yield* iam
              .detachRolePolicy({
                RoleName: DMS_VPC_ROLE_NAME,
                PolicyArn: DMS_VPC_POLICY_ARN,
              })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
            yield* iam
              .deleteRole({ RoleName: DMS_VPC_ROLE_NAME })
              .pipe(
                Effect.catchTag("NoSuchEntityException", () => Effect.void),
              );
            return true;
          }).pipe(
            Effect.catchTag(
              [
                "ConcurrentModificationException",
                "DeleteConflictException",
                "LimitExceededException",
                "ServiceFailureException",
              ],
              () => Effect.succeed(false),
            ),
          );
          if (!deleted) {
            yield* Effect.sleep("1 second");
            continue;
          }

          const remaining = yield* iam
            .getRole({ RoleName: DMS_VPC_ROLE_NAME })
            .pipe(
              Effect.catchTag("NoSuchEntityException", () =>
                Effect.succeed(undefined),
              ),
            );
          if (remaining === undefined) return;
          yield* Effect.sleep("1 second");
        }
        return yield* Effect.die(
          new Error(
            `IAM role ${DMS_VPC_ROLE_NAME} remained observable 30 seconds after the last DMS subnet group was deleted`,
          ),
        );
      });

      const readTags = Effect.fn(function* (arn: string) {
        const response = yield* dms
          .listTagsForResource({ ResourceArn: arn })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return toTagRecord(response?.TagList);
      });

      const toAttrs = Effect.fn(function* (group: dms.ReplicationSubnetGroup) {
        const identifier = group.ReplicationSubnetGroupIdentifier;
        if (!identifier) {
          return yield* Effect.fail(
            new Error("DMS replication subnet group is missing its identifier"),
          );
        }
        const arn = yield* toArn(identifier);
        return {
          replicationSubnetGroupIdentifier: identifier,
          replicationSubnetGroupArn: arn,
          vpcId: group.VpcId,
          subnetIds: (group.Subnets ?? [])
            .map((s) => s.SubnetIdentifier)
            .filter((s): s is string => typeof s === "string"),
          status: group.SubnetGroupStatus,
          tags: yield* readTags(arn),
        };
      });

      return {
        stables: [
          "replicationSubnetGroupIdentifier",
          "replicationSubnetGroupArn",
        ],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(
              id,
              olds ?? ({ subnetIds: [] } as ReplicationSubnetGroupProps),
            )) !== (yield* toName(id, news))
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name =
            output?.replicationSubnetGroupIdentifier ??
            (yield* toName(
              id,
              olds ?? ({ subnetIds: [] } as ReplicationSubnetGroupProps),
            ));
          const group = yield* findGroup(name);
          if (!group?.ReplicationSubnetGroupIdentifier) return undefined;
          const attrs = yield* toAttrs(group);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name =
            output?.replicationSubnetGroupIdentifier ??
            (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const description = news.description ?? "Managed by Alchemy";

          // 1. Observe — cloud state is authoritative.
          let observed = yield* findGroup(name);

          // 2. Ensure — create if missing; tolerate AlreadyExists as a race.
          if (observed === undefined) {
            yield* ensureDmsVpcRole;
            yield* dms
              .createReplicationSubnetGroup({
                ReplicationSubnetGroupIdentifier: name,
                ReplicationSubnetGroupDescription: description,
                SubnetIds: news.subnetIds,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              })
              .pipe(
                // A freshly-created dms-vpc-role takes a few seconds to
                // propagate to DMS, which surfaces as AccessDeniedFault
                // ("The IAM Role ... is not configured properly").
                Effect.catchTag("AccessDeniedFault", (error) =>
                  ensureDmsVpcRole.pipe(Effect.andThen(Effect.fail(error))),
                ),
                Effect.retry({
                  while: (e) => e._tag === "AccessDeniedFault",
                  schedule: Schedule.spaced("5 seconds"),
                  times: 10,
                }),
                Effect.catchTag(
                  "ResourceAlreadyExistsFault",
                  () => Effect.void,
                ),
              );
            observed = yield* findGroup(name);
          } else {
            // 3. Sync — modify description / subnet set in place when they drift.
            const observedSubnets = (observed.Subnets ?? [])
              .map((s) => s.SubnetIdentifier)
              .filter((s): s is string => typeof s === "string");
            if (
              description !== observed.ReplicationSubnetGroupDescription ||
              !sameStringSet(news.subnetIds, observedSubnets)
            ) {
              yield* dms.modifyReplicationSubnetGroup({
                ReplicationSubnetGroupIdentifier: name,
                ReplicationSubnetGroupDescription: description,
                SubnetIds: news.subnetIds,
              });
              observed = yield* findGroup(name);
            }
          }

          if (!observed?.ReplicationSubnetGroupIdentifier) {
            return yield* Effect.fail(
              new Error(
                `DMS replication subnet group '${name}' not found after reconcile`,
              ),
            );
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const arn = yield* toArn(name);
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
          yield* dms
            .deleteReplicationSubnetGroup({
              ReplicationSubnetGroupIdentifier:
                output.replicationSubnetGroupIdentifier,
            })
            .pipe(Effect.catchTag("ResourceNotFoundFault", () => Effect.void));

          // Observe actual absence before discarding state or considering the
          // shared helper unused. DMS deletion is eventually consistent.
          for (let attempt = 0; attempt < 30; attempt++) {
            if (
              (yield* findGroup(output.replicationSubnetGroupIdentifier)) ===
              undefined
            ) {
              yield* deleteOwnedDmsVpcRoleIfUnused;
              return;
            }
            yield* Effect.sleep("1 second");
          }
          yield* Effect.die(
            new Error(
              `DMS replication subnet group ${output.replicationSubnetGroupIdentifier} remained observable 30 seconds after delete`,
            ),
          );
        }),

        list: () =>
          dms.describeReplicationSubnetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ReplicationSubnetGroups ?? []).filter(
                  (group) =>
                    group.ReplicationSubnetGroupIdentifier !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((group) => toAttrs(group), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
