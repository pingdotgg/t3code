import * as kafka from "@distilled.cloud/aws/kafka";
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

export interface ServerlessClusterProps {
  /**
   * Name of the MSK Serverless cluster. Must be 1-64 characters. If omitted, a
   * deterministic physical name is generated. Changing the name replaces the
   * cluster.
   */
  clusterName?: string;
  /**
   * VPC subnets the cluster's brokers are reachable from. At least two subnets
   * in different Availability Zones are required. Changing subnets replaces the
   * cluster.
   */
  subnetIds: string[];
  /**
   * VPC security groups that control network access to the cluster. If omitted,
   * the VPC's default security group is used. Changing security groups replaces
   * the cluster.
   */
  securityGroupIds?: string[];
  /**
   * User-defined tags for the cluster.
   */
  tags?: Record<string, string>;
}

export interface ServerlessCluster extends Resource<
  "AWS.Kafka.ServerlessCluster",
  ServerlessClusterProps,
  {
    /** Name of the cluster. */
    clusterName: string;
    /** ARN of the cluster. */
    clusterArn: string;
    /** Cluster type — always `SERVERLESS` for this resource. */
    clusterType: string;
    /** Current state (`CREATING`, `ACTIVE`, `DELETING`, ...). */
    state: string;
    /**
     * SASL/IAM bootstrap broker connection string — the endpoint kafkajs-style
     * clients connect to using IAM authentication.
     */
    bootstrapBrokerStringSaslIam: string | undefined;
    /** Subnets the cluster is reachable from. */
    subnetIds: string[];
    /** Security groups attached to the cluster. */
    securityGroupIds: string[];
    /** Tags observed on the cluster. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon MSK (Managed Streaming for Apache Kafka) **Serverless** cluster.
 *
 * MSK Serverless clusters use IAM authentication exclusively and scale broker
 * capacity automatically — there is no broker count, instance type, or storage
 * to configure. They are reachable only from inside a VPC. Creation takes
 * roughly 5-10 minutes.
 *
 * The provisioned (broker-count) MSK cluster is a separate, much slower
 * (~20-40 minute) resource and is intentionally not modeled here.
 *
 * @resource
 * @section Creating a Serverless Cluster
 * @example Serverless Cluster in a VPC
 * ```typescript
 * const cluster = yield* ServerlessCluster("Events", {
 *   subnetIds: [subnetA.subnetId, subnetB.subnetId],
 *   securityGroupIds: [kafkaSecurityGroup.securityGroupId],
 * });
 * ```
 *
 * @section Consuming from a Lambda Function
 * @example Wire a topic to a Lambda
 * ```typescript
 * yield* Kafka.consumeKafkaTopic(cluster, { topics: ["orders"] }, (records) =>
 *   records.pipe(Stream.runForEach((r) => Effect.log(r.value))),
 * );
 * ```
 */
export const ServerlessCluster = Resource<ServerlessCluster>(
  "AWS.Kafka.ServerlessCluster",
);

const sameStringSet = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean => {
  const left = [...(a ?? [])].sort();
  const right = [...(b ?? [])].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

const toTagRecord = (
  tags: { [key: string]: string | undefined } | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(tags ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

export const ServerlessClusterProvider = () =>
  Provider.effect(
    ServerlessCluster,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<ServerlessClusterProps>) =>
        props.clusterName
          ? Effect.succeed(props.clusterName)
          : createPhysicalName({ id, maxLength: 64 });

      // Serverless clusters can only be looked up by ARN via describeClusterV2.
      // Before we have an ARN (or after a state-persistence failure) we scan
      // listClustersV2 filtered by name.
      const findByName = Effect.fn(function* (name: string) {
        return yield* kafka.listClustersV2
          .pages({ ClusterNameFilter: name, ClusterTypeFilter: "SERVERLESS" })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk)
                .flatMap((page) => page.ClusterInfoList ?? [])
                .find((c) => c.ClusterName === name),
            ),
          );
      });

      const describeByArn = Effect.fn(function* (arn: string) {
        const response = yield* kafka
          .describeClusterV2({ ClusterArn: arn })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.ClusterInfo;
      });

      const readBrokers = Effect.fn(function* (arn: string) {
        return yield* kafka.getBootstrapBrokers({ ClusterArn: arn }).pipe(
          Effect.map((r) => r.BootstrapBrokerStringSaslIam),
          // Brokers are only resolvable once the cluster is ACTIVE.
          Effect.catchTag("BadRequestException", () =>
            Effect.succeed(undefined),
          ),
          Effect.catchTag("ConflictException", () => Effect.succeed(undefined)),
        );
      });

      // Bounded readiness wait. MSK Serverless create typically completes in
      // 5-10 minutes; budget ~15 min (60 * 15s).
      const waitForActive = Effect.fn(function* (arn: string) {
        const policy = Schedule.max([
          Schedule.fixed("15 seconds"),
          Schedule.recurs(60),
        ]);
        return yield* describeByArn(arn).pipe(
          Effect.flatMap((cluster) => {
            if (!cluster) {
              return Effect.fail(new Error(`MSK cluster '${arn}' not found`));
            }
            if (cluster.State === "FAILED") {
              return Effect.die(
                new Error(
                  `MSK cluster '${arn}' entered FAILED state: ${cluster.StateInfo?.Message ?? ""}`,
                ),
              );
            }
            if (cluster.State !== "ACTIVE") {
              return Effect.fail(
                new Error(
                  `MSK cluster '${arn}' not active (state: ${cluster.State})`,
                ),
              );
            }
            return Effect.succeed(cluster);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toAttrs = Effect.fn(function* (cluster: kafka.Cluster) {
        if (!cluster.ClusterName || !cluster.ClusterArn) {
          return yield* Effect.fail(
            new Error(
              `MSK cluster is missing its name or ARN (state: ${cluster.State})`,
            ),
          );
        }
        const bootstrap =
          cluster.State === "ACTIVE"
            ? yield* readBrokers(cluster.ClusterArn)
            : undefined;
        const vpcConfigs = cluster.Serverless?.VpcConfigs ?? [];
        return {
          clusterName: cluster.ClusterName,
          clusterArn: cluster.ClusterArn,
          clusterType: cluster.ClusterType ?? "SERVERLESS",
          state: cluster.State ?? "ACTIVE",
          bootstrapBrokerStringSaslIam: bootstrap,
          subnetIds: vpcConfigs.flatMap((v) => v.SubnetIds ?? []),
          securityGroupIds: vpcConfigs.flatMap((v) => v.SecurityGroupIds ?? []),
          tags: toTagRecord(cluster.Tags),
        };
      });

      return {
        stables: ["clusterName", "clusterArn", "clusterType"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds ?? {})) !== (yield* toName(id, news ?? {}))
          ) {
            return { action: "replace" } as const;
          }
          // VPC configuration is create-only for serverless clusters.
          if (
            olds?.subnetIds !== undefined &&
            !sameStringSet(news?.subnetIds, olds.subnetIds)
          ) {
            return { action: "replace" } as const;
          }
          if (
            olds?.securityGroupIds !== undefined &&
            !sameStringSet(news?.securityGroupIds, olds.securityGroupIds)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const cluster = output?.clusterArn
            ? yield* describeByArn(output.clusterArn)
            : yield* findByName(yield* toName(id, olds ?? {}));
          if (!cluster?.ClusterArn) return undefined;
          const attrs = yield* toAttrs(cluster);
          return (yield* hasAlchemyTags(id, attrs.tags))
            ? attrs
            : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.clusterName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative. Prefer the cached ARN,
          //    fall back to a name scan (recovery / adoption).
          let observed = output?.clusterArn
            ? yield* describeByArn(output.clusterArn)
            : yield* findByName(name);

          // 2. Ensure — create if missing; tolerate a concurrent create
          //    (ConflictException) by re-scanning for the cluster by name.
          if (!observed?.ClusterArn) {
            const created = yield* kafka
              .createClusterV2({
                ClusterName: name,
                Tags: desiredTags,
                Serverless: {
                  VpcConfigs: [
                    {
                      SubnetIds: news.subnetIds,
                      SecurityGroupIds: news.securityGroupIds,
                    },
                  ],
                  ClientAuthentication: { Sasl: { Iam: { Enabled: true } } },
                },
              })
              .pipe(
                Effect.map((r) => r.ClusterArn),
                Effect.catchTag("ConflictException", () =>
                  findByName(name).pipe(Effect.map((c) => c?.ClusterArn)),
                ),
              );
            if (!created) {
              return yield* Effect.die(
                new Error(`MSK ServerlessCluster(${id}) could not be created`),
              );
            }
            observed = yield* describeByArn(created);
          }

          if (!observed?.ClusterArn) {
            return yield* Effect.die(
              new Error(`MSK ServerlessCluster(${id}) could not be reconciled`),
            );
          }
          const arn = observed.ClusterArn;

          // Wait for ACTIVE (bounded) so tag sync and broker resolution work.
          observed = yield* waitForActive(arn);

          // 3. Sync tags — diff against OBSERVED cloud tags so adoption
          //    rewrites ownership tags correctly.
          const { removed, upsert } = diffTags(
            toTagRecord(observed.Tags),
            desiredTags,
          );
          if (removed.length > 0) {
            yield* kafka.untagResource({ ResourceArn: arn, TagKeys: removed });
          }
          if (upsert.length > 0) {
            yield* kafka.tagResource({
              ResourceArn: arn,
              Tags: Object.fromEntries(
                upsert.map(({ Key, Value }) => [Key, Value]),
              ),
            });
            observed = (yield* describeByArn(arn)) ?? observed;
          }

          // 4. Return fresh attributes.
          yield* session.note(name);
          return yield* toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* kafka.deleteCluster({ ClusterArn: output.clusterArn }).pipe(
            Effect.catchTag("NotFoundException", () => Effect.void),
            // A cluster still CREATING rejects deletion; retry until it can
            // be deleted (or is gone). Bounded.
            Effect.retry({
              while: (e) => e._tag === "BadRequestException",
              schedule: Schedule.max([
                Schedule.fixed("15 seconds"),
                Schedule.recurs(40),
              ]),
            }),
            Effect.catchTag("BadRequestException", () => Effect.void),
          );
        }),

        list: () =>
          kafka.listClustersV2.pages({ ClusterTypeFilter: "SERVERLESS" }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ClusterInfoList ?? []).filter(
                  (c) =>
                    c.ClusterName !== undefined && c.ClusterArn !== undefined,
                ),
              ),
            ),
            Effect.flatMap(
              Effect.forEach((cluster) => toAttrs(cluster), { concurrency: 4 }),
            ),
          ),
      };
    }),
  );
