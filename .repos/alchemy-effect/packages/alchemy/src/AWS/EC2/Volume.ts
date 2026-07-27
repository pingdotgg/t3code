import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { isResolved, somePropsAreDifferent } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createAlchemyTagFilters,
  createInternalTags,
  createTagsList,
  diffTags,
} from "../../Tags.ts";
import type { AccountID } from "../Environment.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { RegionID } from "../Region.ts";
import type { Providers } from "../Providers.ts";

export type VolumeId<ID extends string = string> = `vol-${ID}`;
export const VolumeId = <ID extends string>(id: ID): ID & VolumeId<ID> =>
  `vol-${id}` as ID & VolumeId<ID>;

export type VolumeArn =
  `arn:aws:ec2:${RegionID}:${AccountID}:volume/${VolumeId}`;

export interface VolumeProps {
  /**
   * The Availability Zone in which to create the volume, e.g. `us-east-1a`.
   * Required. An EBS volume is bound to a single AZ; changing it replaces the
   * volume.
   */
  availabilityZone: string;

  /**
   * The size of the volume, in GiB. Required unless you create the volume from
   * a `snapshotId` (in which case it defaults to the snapshot size). The size
   * can be increased in place via `modifyVolume`; decreasing it replaces the
   * volume.
   */
  size?: number;

  /**
   * The volume type.
   * @default "gp3"
   */
  volumeType?: ec2.VolumeType;

  /**
   * The number of I/O operations per second (IOPS). Only valid for `io1`,
   * `io2`, and `gp3` volumes. Mutable in place via `modifyVolume`.
   */
  iops?: number;

  /**
   * The throughput to provision, in MiB/s. Only valid for `gp3` volumes.
   * Mutable in place via `modifyVolume`.
   */
  throughput?: number;

  /**
   * Whether the volume is encrypted. Changing this replaces the volume.
   * @default false
   */
  encrypted?: boolean;

  /**
   * The identifier of the KMS key to use for encryption. Can be a key ID, key
   * ARN, alias name (`alias/my-key`), or alias ARN. Implies `encrypted: true`.
   * Changing this replaces the volume.
   */
  kmsKeyId?: string;

  /**
   * The snapshot from which to create the volume. Changing this replaces the
   * volume.
   */
  snapshotId?: string;

  /**
   * Whether the volume can be attached to multiple instances (Multi-Attach).
   * Only valid for `io1`/`io2` volumes.
   * @default false
   */
  multiAttachEnabled?: boolean;

  /**
   * Tags to assign to the volume. Merged with alchemy auto-tags
   * (alchemy::stack, alchemy::stage, alchemy::id).
   */
  tags?: Record<string, string>;
}

export interface Volume extends Resource<
  "AWS.EC2.Volume",
  VolumeProps,
  {
    /**
     * The ID of the volume.
     */
    volumeId: VolumeId;

    /**
     * The Amazon Resource Name (ARN) of the volume.
     */
    volumeArn: VolumeArn;

    /**
     * The Availability Zone of the volume.
     */
    availabilityZone: string;

    /**
     * The size of the volume, in GiB.
     */
    size: number;

    /**
     * The volume type.
     */
    volumeType: ec2.VolumeType;

    /**
     * The number of IOPS provisioned for the volume.
     */
    iops?: number;

    /**
     * The throughput provisioned for the volume, in MiB/s.
     */
    throughput?: number;

    /**
     * Whether the volume is encrypted.
     */
    encrypted: boolean;

    /**
     * The KMS key used for encryption, if any.
     */
    kmsKeyId?: string;

    /**
     * The snapshot the volume was created from, if any.
     */
    snapshotId?: string;

    /**
     * Whether Multi-Attach is enabled.
     */
    multiAttachEnabled: boolean;

    /**
     * The current state of the volume.
     */
    state: ec2.VolumeState;
  },
  never,
  Providers
> {}
/**
 * An Elastic Block Store (EBS) volume — durable block storage you attach to an
 * EC2 instance via a {@link VolumeAttachment}. Volumes live in a single
 * Availability Zone and persist independently of any instance.
 *
 * Changing `availabilityZone`, `encrypted`, `kmsKeyId`, `snapshotId`, or
 * shrinking `size` replaces the volume. Growing `size` and changing `iops`,
 * `throughput`, or `volumeType` are applied in place via `modifyVolume` (note
 * AWS enforces a 6-hour cooldown between volume modifications).
 *
 * @resource
 * @section Creating a Volume
 * @example Basic gp3 Volume
 * ```typescript
 * const volume = yield* AWS.EC2.Volume("DataVolume", {
 *   availabilityZone: "us-east-1a",
 *   size: 20,
 *   volumeType: "gp3",
 * });
 * ```
 *
 * The minimal volume: a 20 GiB general-purpose `gp3` volume in one AZ. It must
 * be in the same AZ as the instance you attach it to.
 *
 * @section Provisioned Performance
 * @example gp3 with Provisioned IOPS and Throughput
 * ```typescript
 * const fast = yield* AWS.EC2.Volume("FastVolume", {
 *   availabilityZone: "us-east-1a",
 *   size: 100,
 *   volumeType: "gp3",
 *   iops: 6000,
 *   throughput: 250,
 * });
 * ```
 *
 * `gp3` decouples IOPS and throughput from size, so you can provision up to
 * 16,000 IOPS and 1,000 MiB/s independently. Use `io2` for the highest
 * durability and IOPS ceilings.
 *
 * @section Encryption
 * @example Encrypted Volume with a KMS Key
 * ```typescript
 * const secure = yield* AWS.EC2.Volume("SecureVolume", {
 *   availabilityZone: "us-east-1a",
 *   size: 20,
 *   encrypted: true,
 *   kmsKeyId: "alias/my-app-key",
 * });
 * ```
 *
 * Setting `kmsKeyId` implies encryption. Omit it while setting `encrypted:
 * true` to use the account's default EBS KMS key.
 *
 * @section Creating from a Snapshot
 * @example Restore a Volume from a Snapshot
 * ```typescript
 * const restored = yield* AWS.EC2.Volume("RestoredVolume", {
 *   availabilityZone: "us-east-1a",
 *   snapshotId: snapshot.snapshotId,
 * });
 * ```
 *
 * When you create a volume from a snapshot, `size` defaults to the snapshot's
 * size and can only be grown, never shrunk.
 */
export const Volume = Resource<Volume>("AWS.EC2.Volume");

export const VolumeProvider = () =>
  Provider.effect(
    Volume,
    Effect.gen(function* () {
      // EBS volume IDs are server-assigned. Recover a successfully created
      // volume after state persistence failure via the resource instance tag;
      // logical-id-only tags are insufficient during replacement because the
      // old and new volume instances can coexist.
      const findVolumeByInstanceTags = Effect.fn(function* (
        id: string,
        instanceId: string,
      ) {
        const filters = yield* createAlchemyTagFilters(id);
        const pages = yield* ec2.describeVolumes
          .pages({
            Filters: [
              ...filters,
              { Name: "tag:alchemy::instance", Values: [instanceId] },
            ],
          })
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.Volumes ?? [])
          .find(
            (volume) =>
              volume.State !== "deleting" && volume.State !== "deleted",
          );
      });

      return {
        stables: [
          "volumeId",
          "volumeArn",
          "availabilityZone",
          "encrypted",
          "kmsKeyId",
          "snapshotId",
        ],

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (
            somePropsAreDifferent(olds, news, [
              "availabilityZone",
              "encrypted",
              "kmsKeyId",
              "snapshotId",
            ])
          ) {
            return { action: "replace" };
          }
          // Shrinking a volume is not supported in place — replace.
          if (
            olds.size !== undefined &&
            news.size !== undefined &&
            news.size < olds.size
          ) {
            return { action: "replace" };
          }
        }),

        reconcile: Effect.fn(function* ({
          id,
          instanceId,
          news,
          output,
          session,
        }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const alchemyTags = yield* createInternalTags(id);
          const desiredTags = {
            ...news.tags,
            ...alchemyTags,
            "alchemy::instance": instanceId,
          };

          // 1. OBSERVE — cloud state is authoritative; output is only an id
          //    cache. A volume in a terminal state is treated as missing.
          let volume: ec2.Volume | undefined;
          if (output?.volumeId) {
            const lookup = yield* ec2
              .describeVolumes({ VolumeIds: [output.volumeId] })
              .pipe(
                Effect.catchTag("InvalidVolume.NotFound", () =>
                  Effect.succeed({ Volumes: [] }),
                ),
              );
            const found = lookup.Volumes?.[0];
            if (
              found &&
              found.State !== "deleting" &&
              found.State !== "deleted"
            ) {
              volume = found;
            }
          }
          if (volume === undefined) {
            volume = yield* findVolumeByInstanceTags(id, instanceId);
          }

          // 2. ENSURE — create the volume when missing, then wait until it is
          //    available.
          if (volume === undefined) {
            const created = yield* ec2.createVolume({
              AvailabilityZone: news.availabilityZone,
              Size: news.size,
              VolumeType: news.volumeType ?? "gp3",
              Iops: news.iops,
              Throughput: news.throughput,
              Encrypted:
                news.encrypted ??
                (news.kmsKeyId !== undefined ? true : undefined),
              KmsKeyId: news.kmsKeyId,
              SnapshotId: news.snapshotId,
              MultiAttachEnabled: news.multiAttachEnabled,
              TagSpecifications: [
                {
                  ResourceType: "volume",
                  Tags: createTagsList(desiredTags),
                },
              ],
              DryRun: false,
            });
            const volumeId = created.VolumeId! as VolumeId;
            yield* session.note(`Volume created: ${volumeId}`);
            volume = yield* waitForVolumeAvailable(volumeId, session);
          }

          const volumeId = volume.VolumeId! as VolumeId;

          // 3. SYNC — grow size / adjust performance in place. Only include a
          //    field when the user specified it AND it drifts from observed
          //    cloud state, so a no-op reconcile never triggers the 6h
          //    modification cooldown.
          const modify: ec2.ModifyVolumeRequest = { VolumeId: volumeId };
          let needsModify = false;
          if (news.size !== undefined && news.size > (volume.Size ?? 0)) {
            modify.Size = news.size;
            needsModify = true;
          }
          if (
            news.volumeType !== undefined &&
            news.volumeType !== volume.VolumeType
          ) {
            modify.VolumeType = news.volumeType;
            needsModify = true;
          }
          if (news.iops !== undefined && news.iops !== volume.Iops) {
            modify.Iops = news.iops;
            needsModify = true;
          }
          if (
            news.throughput !== undefined &&
            news.throughput !== volume.Throughput
          ) {
            modify.Throughput = news.throughput;
            needsModify = true;
          }
          if (needsModify) {
            yield* ec2.modifyVolume(modify);
            yield* session.note(`Volume modified: ${volumeId}`);
          }

          // 3b. SYNC TAGS — diff against observed cloud tags.
          const currentTags = Object.fromEntries(
            (volume.Tags ?? []).map((t) => [t.Key!, t.Value!]),
          ) as Record<string, string>;
          const { removed, upsert } = diffTags(currentTags, desiredTags);
          if (removed.length > 0) {
            yield* ec2.deleteTags({
              Resources: [volumeId],
              Tags: removed.map((key) => ({ Key: key })),
              DryRun: false,
            });
          }
          if (upsert.length > 0) {
            yield* ec2.createTags({
              Resources: [volumeId],
              Tags: upsert,
              DryRun: false,
            });
          }

          // 4. RETURN fresh attributes.
          const finalLookup = yield* ec2.describeVolumes({
            VolumeIds: [volumeId],
          });
          const final = finalLookup.Volumes?.[0] ?? volume;
          return toVolumeAttributes(final, region, accountId);
        }),

        // Enumerate every volume in the ambient account/region.
        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const chunk = yield* ec2.describeVolumes
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(chunk).flatMap((page) =>
              (page.Volumes ?? []).map((v) =>
                toVolumeAttributes(v, region, accountId),
              ),
            );
          }),

        delete: Effect.fn(function* ({ output, session }) {
          const volumeId = output.volumeId;
          yield* session.note(`Deleting volume: ${volumeId}`);

          yield* ec2.deleteVolume({ VolumeId: volumeId, DryRun: false }).pipe(
            Effect.tapError(Effect.logDebug),
            Effect.catchTag("InvalidVolume.NotFound", () => Effect.void),
            // A volume that is still detaching reports VolumeInUse — retry
            // until the detach completes.
            Effect.retry({
              while: (e) => e._tag === "VolumeInUse",
              schedule: Schedule.max([
                Schedule.fixed(3000),
                Schedule.recurs(20),
              ]).pipe(
                Schedule.tap(({ attempt }) =>
                  session.note(
                    `Waiting for volume to detach... (attempt ${attempt + 1})`,
                  ),
                ),
              ),
            }),
          );

          yield* waitForVolumeDeleted(volumeId, session);
          yield* session.note(`Volume ${volumeId} deleted successfully`);
        }),
      };
    }),
  );

const toVolumeAttributes = (
  volume: ec2.Volume,
  region: RegionID,
  accountId: AccountID,
): Volume["Attributes"] => {
  const volumeId = volume.VolumeId! as VolumeId;
  return {
    volumeId,
    volumeArn:
      `arn:aws:ec2:${region}:${accountId}:volume/${volumeId}` as VolumeArn,
    availabilityZone: volume.AvailabilityZone!,
    size: volume.Size ?? 0,
    volumeType: volume.VolumeType ?? "gp3",
    iops: volume.Iops,
    throughput: volume.Throughput,
    encrypted: volume.Encrypted ?? false,
    kmsKeyId: volume.KmsKeyId,
    snapshotId:
      volume.SnapshotId && volume.SnapshotId.length > 0
        ? volume.SnapshotId
        : undefined,
    multiAttachEnabled: volume.MultiAttachEnabled ?? false,
    state: volume.State ?? "creating",
  };
};

class VolumeNotReady extends Data.TaggedError("VolumeNotReady")<{
  volumeId: string;
  state: string;
}> {}

class VolumeStillExists extends Data.TaggedError("VolumeStillExists")<{
  volumeId: string;
  state: string;
  message: string;
}> {}

/**
 * Wait for the volume to reach the `available` state.
 */
const waitForVolumeAvailable = (
  volumeId: string,
  session?: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2.describeVolumes({ VolumeIds: [volumeId] });
    const volume = result.Volumes?.[0];
    if (!volume) {
      return yield* Effect.fail(new Error(`Volume ${volumeId} not found`));
    }
    if (volume.State === "available" || volume.State === "in-use") {
      return volume;
    }
    if (volume.State === "error") {
      return yield* Effect.fail(
        new Error(`Volume ${volumeId} entered error state`),
      );
    }
    return yield* new VolumeNotReady({ volumeId, state: volume.State! });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof VolumeNotReady,
      schedule: Schedule.max([
        Schedule.fixed(2000),
        Schedule.recurs(30), // max ~60s
      ]).pipe(
        Schedule.tap(({ attempt }) =>
          session
            ? session.note(
                `Waiting for volume to be available... (${(attempt + 1) * 2}s)`,
              )
            : Effect.void,
        ),
      ),
    }),
  );

/**
 * Wait for the volume to be fully deleted.
 */
const waitForVolumeDeleted = (
  volumeId: string,
  session: ScopedPlanStatusSession,
) =>
  Effect.gen(function* () {
    const result = yield* ec2
      .describeVolumes({ VolumeIds: [volumeId] })
      .pipe(
        Effect.catchTag("InvalidVolume.NotFound", () =>
          Effect.succeed({ Volumes: [] }),
        ),
      );
    const volume = result.Volumes?.[0];
    // Do not treat `deleting` as deleted. The provider's delete contract is
    // complete only after EC2 stops returning the volume; otherwise nuke can
    // report success while the resource remains in its inventory.
    if (!volume || volume.State === "deleted") {
      return;
    }
    return yield* new VolumeStillExists({
      volumeId,
      state: volume.State ?? "unknown",
      message:
        `Volume ${volumeId} remains ${volume.State ?? "visible"} after the bounded delete wait; ` +
        "AWS accepted DeleteVolume but has not removed it",
    });
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof VolumeStillExists,
      schedule: Schedule.max([
        Schedule.fixed(2000),
        // give the delete call ~60s to be reflected by describeVolumes
        Schedule.recurs(30),
      ]).pipe(
        Schedule.tap(({ attempt }) =>
          session.note(
            `Waiting for volume deletion... (${(attempt + 1) * 2}s)`,
          ),
        ),
      ),
    }),
  );
