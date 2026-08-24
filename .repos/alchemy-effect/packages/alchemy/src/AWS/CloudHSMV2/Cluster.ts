import * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasAlchemyTags,
} from "../../Tags.ts";
import { toWireDays } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import { findClusterById, sameStringSet, toTagRecord } from "./internal.ts";

export interface ClusterProps {
  /**
   * Type of HSM the cluster hosts, e.g. `"hsm2m.medium"` (current
   * generation) or `"hsm1.medium"` (legacy). Changing the HSM type replaces
   * the cluster.
   */
  hsmType: string;
  /**
   * IDs of the subnets the cluster's HSMs may be placed into. Each subnet
   * must be in a different Availability Zone of the same VPC. Changing the
   * subnets replaces the cluster.
   */
  subnetIds: string[];
  /**
   * ID (or, cross-account, the full ARN) of a cluster backup to restore the
   * new cluster from. Changing the source backup replaces the cluster.
   */
  sourceBackupId?: string;
  /**
   * IP address type of the cluster's endpoints — `"IPV4"` or `"DUALSTACK"`.
   * Changing the network type replaces the cluster.
   * @default "IPV4"
   */
  networkType?: cloudhsm.NetworkType;
  /**
   * Whether the cluster runs in `"FIPS"` or `"NON_FIPS"` mode. Changing the
   * mode replaces the cluster.
   * @default "FIPS"
   */
  mode?: cloudhsm.ClusterMode;
  /**
   * How long automatic backups of the cluster are retained (e.g. `"30 days"`
   * or `Duration.days(30)`; a bare number is milliseconds). Converted to
   * whole days on the wire. Updated in place via ModifyCluster.
   * @default 90 days
   */
  backupRetention?: Duration.Input;
  /**
   * User-defined tags for the cluster.
   */
  tags?: Record<string, string>;
}

export interface Cluster extends Resource<
  "AWS.CloudHSMV2.Cluster",
  ClusterProps,
  {
    /**
     * The unique identifier of the cluster.
     */
    clusterId: string;
    /**
     * Current state of the cluster (e.g. `UNINITIALIZED`, `ACTIVE`).
     */
    state: string;
    /**
     * The type of HSM in the cluster (e.g. `hsm2m.medium`).
     */
    hsmType: string;
    /**
     * The FIPS mode of the cluster (`FIPS` or `NON_FIPS`).
     */
    mode: string | undefined;
    /**
     * The network type of the cluster (`IPV4` or `DUALSTACK`).
     */
    networkType: string | undefined;
    /**
     * The VPC the cluster's HSMs live in.
     */
    vpcId: string | undefined;
    /**
     * The security group CloudHSM created for the cluster's ENIs.
     */
    securityGroup: string | undefined;
    /**
     * The subnets (one per AZ) the cluster spans.
     */
    subnetIds: string[];
    /**
     * The certificate signing request to sign when initializing the cluster
     * (present while `UNINITIALIZED`).
     */
    clusterCsr: string | undefined;
    /**
     * How many days backups are retained.
     */
    backupRetentionDays: number | undefined;
    /**
     * Current tags on the cluster.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS CloudHSM cluster — a fleet of FIPS-validated, single-tenant
 * hardware security modules (HSMs) inside your VPC.
 *
 * A fresh cluster provisions to the `UNINITIALIZED` state in a few minutes
 * and holds no HSMs; add {@link Hsm} resources to place HSMs into its
 * subnets' Availability Zones (each HSM is billed hourly). Activating the
 * cluster (signing the cluster CSR and calling InitializeCluster) is an
 * offline certificate-authority ceremony that stays out of band — the
 * `clusterCsr` attribute exposes the CSR to sign.
 * @resource
 * @section Creating a Cluster
 * @example Cluster Spanning Two Availability Zones
 * ```typescript
 * const cluster = yield* Cluster("HsmCluster", {
 *   hsmType: "hsm2m.medium",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * ```
 *
 * @example Non-FIPS Cluster with Custom Backup Retention
 * ```typescript
 * const cluster = yield* Cluster("HsmCluster", {
 *   hsmType: "hsm2m.medium",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   mode: "NON_FIPS",
 *   backupRetention: "30 days",
 * });
 * ```
 *
 * @section Adding HSMs
 * @example Cluster with One HSM
 * ```typescript
 * const cluster = yield* Cluster("HsmCluster", {
 *   hsmType: "hsm2m.medium",
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 * });
 * const hsm = yield* Hsm("Primary", {
 *   clusterId: cluster.clusterId,
 *   availabilityZone: "us-west-2a",
 * });
 * ```
 */
export const Cluster = Resource<Cluster>("AWS.CloudHSMV2.Cluster");

/** Cluster states that mean "gone" for reconciliation purposes. */
const isGone = (cluster: cloudhsm.Cluster | undefined) =>
  cluster === undefined ||
  cluster.State === "DELETED" ||
  cluster.State === "DELETE_IN_PROGRESS";

export const ClusterProvider = () =>
  Provider.effect(
    Cluster,
    Effect.gen(function* () {
      // Read the observed tags for a cluster. A cluster mid-transition can
      // transiently reject listTags; treat failure as "no observed tags" so
      // tag reconciliation re-runs on the next pass.
      const readClusterTags = Effect.fn(function* (clusterId: string) {
        const response = yield* cloudhsm
          .listTags({ ResourceId: clusterId })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return toTagRecord(response?.TagList);
      });

      // CloudHSM clusters have no caller-chosen name — the id is
      // auto-assigned. When we have no cached id (state persistence failed
      // mid-reconcile), recover ownership by scanning for the cluster
      // carrying our alchemy tags.
      const findClusterByAlchemyTags = Effect.fn(function* (id: string) {
        const pages = yield* cloudhsm.describeClusters
          .pages({})
          .pipe(Stream.runCollect);
        for (const page of pages) {
          for (const cluster of page.Clusters ?? []) {
            if (isGone(cluster)) continue;
            if (yield* hasAlchemyTags(id, toTagRecord(cluster.TagList))) {
              return cluster;
            }
          }
        }
        return undefined;
      });

      // Bounded settle wait: creation and modification park the cluster in a
      // *_IN_PROGRESS state; the cluster itself settles in a few minutes
      // (budget 10 min = 40 * 15s).
      const waitUntilSettled = Effect.fn(function* (clusterId: string) {
        const policy = Schedule.max([
          Schedule.fixed("15 seconds"),
          Schedule.recurs(40),
        ]);
        return yield* findClusterById(clusterId).pipe(
          Effect.flatMap((cluster) => {
            if (cluster === undefined) {
              return Effect.fail(
                new Error(`CloudHSM cluster '${clusterId}' not found`),
              );
            }
            if (cluster.State?.endsWith("_IN_PROGRESS")) {
              return Effect.fail(
                new Error(
                  `CloudHSM cluster '${clusterId}' still settling (state: ${cluster.State})`,
                ),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = Effect.fn(function* (cluster: cloudhsm.Cluster) {
        if (!cluster.ClusterId) {
          return yield* Effect.fail(
            new Error("CloudHSM cluster is missing its ClusterId"),
          );
        }
        return {
          clusterId: cluster.ClusterId,
          state: cluster.State ?? "UNINITIALIZED",
          hsmType: cluster.HsmType ?? "",
          mode: cluster.Mode,
          networkType: cluster.NetworkType,
          vpcId: cluster.VpcId,
          securityGroup: cluster.SecurityGroup,
          subnetIds: Object.values(cluster.SubnetMapping ?? {}).filter(
            (s): s is string => s !== undefined,
          ),
          clusterCsr: cluster.Certificates?.ClusterCsr,
          backupRetentionDays:
            cluster.BackupRetentionPolicy?.Value !== undefined
              ? Number(cluster.BackupRetentionPolicy.Value)
              : undefined,
          tags: toTagRecord(cluster.TagList),
        };
      });

      return {
        stables: ["clusterId", "vpcId", "securityGroup"],

        diff: Effect.fn(function* ({ olds, news }) {
          if (!isResolved(news)) return undefined;
          const n = news ?? { hsmType: "", subnetIds: [] };
          const o = olds ?? { hsmType: "", subnetIds: [] };
          // Create-only properties force a replacement.
          if (n.hsmType !== o.hsmType) {
            return { action: "replace" } as const;
          }
          if (!sameStringSet(n.subnetIds, o.subnetIds)) {
            return { action: "replace" } as const;
          }
          if (n.sourceBackupId !== o.sourceBackupId) {
            return { action: "replace" } as const;
          }
          if ((n.networkType ?? "IPV4") !== (o.networkType ?? "IPV4")) {
            return { action: "replace" } as const;
          }
          if ((n.mode ?? undefined) !== (o.mode ?? undefined)) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          const cluster = output?.clusterId
            ? yield* findClusterById(output.clusterId)
            : yield* findClusterByAlchemyTags(id);
          if (cluster === undefined || cluster.State === "DELETED") {
            return undefined;
          }
          const attrs = yield* toAttrs(cluster);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news!;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };
          const backupRetentionDays = toWireDays(props.backupRetention);

          // 1. Observe — cloud state is authoritative; output is only an id
          //    cache. Without one, recover by alchemy tags (crash recovery /
          //    adoption both land here).
          let observed = output?.clusterId
            ? yield* findClusterById(output.clusterId)
            : yield* findClusterByAlchemyTags(id);

          // 2. Ensure — create if missing (or terminally deleted).
          if (isGone(observed)) {
            const created = yield* cloudhsm.createCluster({
              HsmType: props.hsmType,
              SubnetIds: props.subnetIds,
              SourceBackupId: props.sourceBackupId,
              NetworkType: props.networkType,
              Mode: props.mode,
              BackupRetentionPolicy:
                backupRetentionDays !== undefined
                  ? { Type: "DAYS", Value: String(backupRetentionDays) }
                  : undefined,
              TagList: createTagsList(desiredTags),
            });
            observed = created.Cluster;
          }
          const clusterId = observed?.ClusterId;
          if (!clusterId) {
            return yield* Effect.fail(
              new Error("CreateCluster returned no ClusterId"),
            );
          }

          // Creation/modification park the cluster in *_IN_PROGRESS; wait
          // (bounded) so subsequent modify calls do not race the transition.
          observed = yield* waitUntilSettled(clusterId);

          // 3. Sync backup retention — diff OBSERVED policy against desired.
          if (
            backupRetentionDays !== undefined &&
            String(backupRetentionDays) !==
              observed.BackupRetentionPolicy?.Value
          ) {
            yield* cloudhsm.modifyCluster({
              ClusterId: clusterId,
              BackupRetentionPolicy: {
                Type: "DAYS",
                Value: String(backupRetentionDays),
              },
            });
            observed = yield* waitUntilSettled(clusterId);
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readClusterTags(clusterId);
          const { removed, upsert } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* cloudhsm.tagResource({
              ResourceId: clusterId,
              TagList: upsert,
            });
          }
          if (removed.length > 0) {
            yield* cloudhsm.untagResource({
              ResourceId: clusterId,
              TagKeyList: removed,
            });
          }

          yield* session.note(clusterId);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const clusterId = output.clusterId;
          const observed = yield* findClusterById(clusterId);
          if (isGone(observed)) return;
          // Before a cluster can be deleted all of its HSMs must be gone;
          // HSM deletion initiated by dependent resources may still be
          // propagating, which surfaces as CloudHsmInvalidRequestException.
          // Bounded retry through that window (10 min = 40 * 15s).
          yield* cloudhsm.deleteCluster({ ClusterId: clusterId }).pipe(
            Effect.retry({
              while: (e) => e._tag === "CloudHsmInvalidRequestException",
              schedule: Schedule.max([
                Schedule.fixed("15 seconds"),
                Schedule.recurs(40),
              ]),
            }),
            Effect.catchTag(
              "CloudHsmResourceNotFoundException",
              () => Effect.void,
            ),
          );
        }),

        list: () =>
          Effect.gen(function* () {
            const pages = yield* cloudhsm.describeClusters
              .pages({})
              .pipe(Stream.runCollect);
            const clusters = Array.from(pages)
              .flatMap((page) => page.Clusters ?? [])
              .filter(
                (cluster) =>
                  cluster.ClusterId !== undefined &&
                  cluster.State !== "DELETED",
              );
            return yield* Effect.forEach(clusters, (cluster) =>
              toAttrs(cluster),
            );
          }),
      };
    }),
  );
