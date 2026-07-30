import * as efs from "@distilled.cloud/aws/efs";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface MountTargetProps {
  /**
   * ID of the EFS file system to expose through this mount target
   * (e.g. `fileSystem.fileSystemId`). Cannot be changed after creation
   * (replacement).
   */
  fileSystemId: string;
  /**
   * ID of the subnet to create the mount target in. Determines the VPC and
   * Availability Zone; one mount target is allowed per AZ. Cannot be changed
   * after creation (replacement).
   */
  subnetId: string;
  /**
   * Static private IPv4 address for the mount target within the subnet's
   * range. Cannot be changed after creation (replacement).
   * @default an address assigned by EFS
   */
  ipAddress?: string;
  /**
   * Security groups attached to the mount target's network interface (up to
   * five). NFS clients must be allowed to reach TCP port 2049 through these
   * groups. Updatable in place.
   * @default the VPC's default security group
   */
  securityGroups?: string[];
}

export interface MountTarget extends Resource<
  "AWS.EFS.MountTarget",
  MountTargetProps,
  {
    /** The ID of the mount target (e.g. `fsmt-0123456789abcdef0`). */
    mountTargetId: string;
    /** The ID of the EFS file system the mount target belongs to. */
    fileSystemId: string;
    /** The ID of the subnet the mount target was created in. */
    subnetId: string;
    /** The IPv4 address at which the file system is reachable in the subnet. */
    ipAddress: string | undefined;
    /** The ID of the network interface created for the mount target. */
    networkInterfaceId: string | undefined;
    /** The name of the Availability Zone the mount target resides in. */
    availabilityZoneName: string | undefined;
  },
  {},
  Providers
> {}

/**
 * An Amazon EFS mount target — the per-subnet network endpoint (an ENI
 * serving NFS on TCP 2049) that compute in a VPC uses to reach a file
 * system.
 *
 * Create one mount target per Availability Zone you run compute in. The
 * reconciler waits for the mount target to reach the `available` state
 * (typically 1–2 minutes), so downstream resources that depend on its
 * attributes deploy only once the endpoint is usable. Deletion likewise
 * waits until the mount target is fully gone, because its ENI must be
 * released before the subnet, security groups, or file system can be
 * deleted.
 * @resource
 * @section Creating Mount Targets
 * @example Mount target in a subnet
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const files = yield* AWS.EFS.FileSystem("Files");
 * const target = yield* AWS.EFS.MountTarget("FilesTarget", {
 *   fileSystemId: files.fileSystemId,
 *   subnetId,
 * });
 * ```
 *
 * @example Mount target with explicit security groups
 * ```typescript
 * const target = yield* AWS.EFS.MountTarget("FilesTarget", {
 *   fileSystemId: files.fileSystemId,
 *   subnetId,
 *   securityGroups: [nfsSecurityGroupId],
 * });
 * ```
 */
export const MountTarget = Resource<MountTarget>("AWS.EFS.MountTarget");

/**
 * Internal marker error used to drive the bounded wait for a mount target to
 * reach the `available` lifecycle state.
 */
export class MountTargetNotAvailable extends Data.TaggedError(
  "MountTargetNotAvailable",
)<{ mountTargetId: string; state: string }> {}

/**
 * Internal marker error used to drive the bounded wait for a mount target to
 * disappear after deletion (its ENI releases asynchronously).
 */
export class MountTargetStillDeleting extends Data.TaggedError(
  "MountTargetStillDeleting",
)<{ mountTargetId: string; state: string }> {}

/**
 * Mount-target provisioning takes 1–3 minutes. Bounded poll (5s × 36 ≈
 * 180s), explicitly typed so declaration emit never widens the provider
 * layer (see PATTERNS §7).
 */
const retryUntilMountTargetAvailable = <E extends { _tag: string }, R>(
  self: Effect.Effect<efs.MountTargetDescription, E, R>,
): Effect.Effect<efs.MountTargetDescription, E | MountTargetNotAvailable, R> =>
  Effect.retry(
    Effect.flatMap(self, (mt) =>
      mt.LifeCycleState === "available"
        ? Effect.succeed(mt)
        : Effect.fail(
            new MountTargetNotAvailable({
              mountTargetId: mt.MountTargetId,
              state: mt.LifeCycleState,
            }),
          ),
    ),
    {
      while: (e) => e._tag === "MountTargetNotAvailable",
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(36),
      ]),
    },
  );

/**
 * Deletion releases the mount target's ENI asynchronously (1–3 minutes).
 * Bounded poll (5s × 36 ≈ 180s) until the mount target is observed gone,
 * explicitly typed (PATTERNS §7).
 */
const retryUntilMountTargetGone = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) => e._tag === "MountTargetStillDeleting",
    schedule: Schedule.max([Schedule.fixed("5 seconds"), Schedule.recurs(36)]),
  });

/**
 * Security-group modifications race the mount target's own state machine;
 * `IncorrectMountTargetState` while it is still creating is transient.
 * Bounded retry (~60s), explicitly typed (PATTERNS §7).
 */
const retryWhileMountTargetSettling = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e) =>
      e._tag === "IncorrectMountTargetState" || e._tag === "DependencyTimeout",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(20)]),
  });

export const MountTargetProvider = () =>
  Provider.effect(
    MountTarget,
    Effect.gen(function* () {
      const findById = Effect.fn(function* (mountTargetId: string) {
        return yield* efs
          .describeMountTargets({ MountTargetId: mountTargetId })
          .pipe(
            Effect.map((r) => r.MountTargets?.[0]),
            Effect.catchTag("MountTargetNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const findBySubnet = Effect.fn(function* (
        fileSystemId: string,
        subnetId: string,
      ) {
        return yield* efs
          .describeMountTargets({ FileSystemId: fileSystemId })
          .pipe(
            Effect.map((r) =>
              r.MountTargets?.find((mt) => mt.SubnetId === subnetId),
            ),
            Effect.catchTag("FileSystemNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttributes = (mt: efs.MountTargetDescription) => ({
        mountTargetId: mt.MountTargetId,
        fileSystemId: mt.FileSystemId,
        subnetId: mt.SubnetId,
        ipAddress: mt.IpAddress,
        networkInterfaceId: mt.NetworkInterfaceId,
        availabilityZoneName: mt.AvailabilityZoneName,
      });

      return MountTarget.Provider.of({
        stables: [
          "mountTargetId",
          "fileSystemId",
          "subnetId",
          "ipAddress",
          "availabilityZoneName",
        ],

        // Mount targets are only enumerable per file system, so walk every
        // file system in the account/region. A file system can vanish between
        // the enumeration and the per-FS describe — drop it.
        list: () =>
          Effect.gen(function* () {
            const systems = yield* efs.describeFileSystems.items({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) => Array.from(chunk)),
            );
            const perSystem = yield* Effect.forEach(
              systems,
              (fs) =>
                efs
                  .describeMountTargets({ FileSystemId: fs.FileSystemId })
                  .pipe(
                    Effect.map((r) =>
                      (r.MountTargets ?? [])
                        .filter((mt) => mt.LifeCycleState !== "deleted")
                        .map(toAttributes),
                    ),
                    Effect.catchTag("FileSystemNotFound", () =>
                      Effect.succeed([]),
                    ),
                  ),
              { concurrency: 5 },
            );
            return perSystem.flat();
          }),

        // Mount targets are untaggable, so there is no ownership marker to
        // check: identity is the (fileSystemId, subnetId) pair, matching the
        // one-mount-target-per-AZ constraint.
        read: Effect.fn(function* ({ olds, output }) {
          const mt = output?.mountTargetId
            ? yield* findById(output.mountTargetId)
            : olds?.fileSystemId && olds.subnetId
              ? yield* findBySubnet(olds.fileSystemId, olds.subnetId)
              : undefined;
          if (mt === undefined || mt.LifeCycleState === "deleted") {
            return undefined;
          }
          return toAttributes(mt);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news) || olds === undefined) return undefined;
          if (
            news.fileSystemId !== olds.fileSystemId ||
            news.subnetId !== olds.subnetId ||
            news.ipAddress !== olds.ipAddress
          ) {
            return { action: "replace" } as const;
          }
          // undefined → default update path (security-group sync)
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          // 1. OBSERVE — output.mountTargetId is only a cache; fall through
          //    to the (fileSystemId, subnetId) identity if it is stale.
          let mt = output?.mountTargetId
            ? yield* findById(output.mountTargetId)
            : undefined;
          if (mt === undefined || mt.LifeCycleState === "deleted") {
            mt = yield* findBySubnet(news.fileSystemId, news.subnetId);
          }
          if (mt?.LifeCycleState === "deleted") {
            mt = undefined;
          }

          // 2. ENSURE — create if missing. `MountTargetConflict` means a peer
          //    created it in the same subnet/AZ concurrently — re-observe.
          if (mt === undefined) {
            mt = yield* efs
              .createMountTarget({
                FileSystemId: news.fileSystemId,
                SubnetId: news.subnetId,
                IpAddress: news.ipAddress,
                SecurityGroups: news.securityGroups,
              })
              .pipe(
                Effect.catchTag("MountTargetConflict", () =>
                  findBySubnet(news.fileSystemId, news.subnetId).pipe(
                    Effect.flatMap((existing) =>
                      existing !== undefined
                        ? Effect.succeed(existing)
                        : efs.createMountTarget({
                            FileSystemId: news.fileSystemId,
                            SubnetId: news.subnetId,
                            IpAddress: news.ipAddress,
                            SecurityGroups: news.securityGroups,
                          }),
                    ),
                  ),
                ),
              );
          }

          const mountTargetId = mt.MountTargetId;

          // Wait for the network endpoint to become usable — dependents
          // (e.g. a Lambda with fileSystemConfigs) fail to create against a
          // mount target that is still `creating`.
          yield* session.note(`waiting for ${mountTargetId} to be available`);
          mt = yield* retryUntilMountTargetAvailable(
            efs
              .describeMountTargets({ MountTargetId: mountTargetId })
              .pipe(Effect.map((r) => r.MountTargets![0])),
          );

          // 3. SYNC security groups — diff the OBSERVED set against the
          //    desired one; only call the API on a real delta. When the prop
          //    is omitted the observed groups (VPC default) are left alone.
          if (news.securityGroups !== undefined) {
            const observed = yield* efs
              .describeMountTargetSecurityGroups({
                MountTargetId: mountTargetId,
              })
              .pipe(Effect.map((r) => [...r.SecurityGroups].sort()));
            const desired = [...news.securityGroups].sort();
            if (JSON.stringify(observed) !== JSON.stringify(desired)) {
              yield* retryWhileMountTargetSettling(
                efs.modifyMountTargetSecurityGroups({
                  MountTargetId: mountTargetId,
                  SecurityGroups: news.securityGroups,
                }),
              );
            }
          }

          yield* session.note(mountTargetId);
          return toAttributes(mt);
        }),

        // Deletion must observe the mount target actually GONE before
        // returning: its ENI is released asynchronously and the subnet,
        // security groups, and file system cannot be deleted until then.
        delete: Effect.fn(function* ({ output, session }) {
          yield* efs
            .deleteMountTarget({ MountTargetId: output.mountTargetId })
            .pipe(Effect.catchTag("MountTargetNotFound", () => Effect.void));

          yield* session.note(
            `waiting for ${output.mountTargetId} to be deleted`,
          );
          yield* retryUntilMountTargetGone(
            efs
              .describeMountTargets({ MountTargetId: output.mountTargetId })
              .pipe(
                Effect.flatMap((r) => {
                  const state = r.MountTargets?.[0]?.LifeCycleState;
                  return state === undefined || state === "deleted"
                    ? Effect.void
                    : Effect.fail(
                        new MountTargetStillDeleting({
                          mountTargetId: output.mountTargetId,
                          state,
                        }),
                      );
                }),
                Effect.catchTag("MountTargetNotFound", () => Effect.void),
              ),
          );
        }),
      });
    }),
  );
