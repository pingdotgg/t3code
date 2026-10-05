import * as kafka from "@distilled.cloud/gcp/managedkafka_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  expandParent,
  fingerprint,
  getAcl,
  listAlchemyClusters,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryTransient,
  toPhysicalId,
} from "./internal.ts";

export type AclEntry = {
  /**
   * Operation (`ALL`, `READ`, `WRITE`, `CREATE`, `DELETE`, `ALTER`,
   * `DESCRIBE`, `CLUSTER_ACTION`, `DESCRIBE_CONFIGS`, `ALTER_CONFIGS`,
   * `IDEMPOTENT_WRITE`).
   */
  operation?: string;
  /**
   * Host. Must be `*` for Managed Service for Apache Kafka.
   * @default "*"
   */
  host?: string;
  /**
   * Permission type (`ALLOW`, `DENY`).
   */
  permissionType?: string;
  /**
   * Principal (`User:sa@project.iam.gserviceaccount.com` or `User:*`).
   */
  principal?: string;
};

export type ClustersAclProps = {
  /**
   * Parent cluster. Full name
   * `projects/{project}/locations/{location}/clusters/{cluster}` or the
   * cluster id (combined with `location`). Immutable — changing it
   * replaces the ACL.
   */
  cluster: string;
  /**
   * Region used when `cluster` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * ACL id. Defines the Resource Pattern:
   * `cluster`, `topic/{name}`, `consumerGroup/{name}`,
   * `transactionalId/{name}`, `topicPrefixed/{name}`, `allTopics`,
   * `allConsumerGroups`, `allTransactionalIds`. If omitted, a topic
   * pattern is generated from the logical id. Immutable — changing it
   * replaces the ACL.
   */
  aclId?: string;
  /**
   * ACL entries for the resource pattern. Maximum 100.
   */
  aclEntries: AclEntry[];
};

export type ClustersAcl = Resource<
  "GCP.ManagedKafka.ClustersAcl",
  ClustersAclProps,
  {
    /** Full resource name `.../clusters/{cluster}/acls/{acl_id}`. */
    name: string;
    /** ACL id (resource pattern). */
    aclId: string;
    /** Parent cluster resource name. */
    cluster: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** ACL entries currently applied. */
    aclEntries: AclEntry[];
    /** Pattern type (`LITERAL`, `PREFIXED`). */
    patternType: string | undefined;
    /** Resource name derived from the ACL id. */
    resourceName: string | undefined;
    /** Resource type (`CLUSTER`, `TOPIC`, `GROUP`, `TRANSACTIONAL_ID`). */
    resourceType: string | undefined;
    /** Etag for concurrency control. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * An ACL for a Kafka resource pattern on a Managed Kafka cluster.
 *
 * The ACL id encodes the resource pattern and is immutable. Entries
 * update in place.
 *
 * ### Creating an ACL
 * **Example:** Allow all users to describe a topic
 * ```typescript
 * const acl = yield* GCP.ManagedKafka.ClustersAcl("OrdersAcl", {
 *   cluster: cluster.name,
 *   aclId: "topic/orders",
 *   aclEntries: [
 *     {
 *       principal: "User:*",
 *       operation: "DESCRIBE",
 *       permissionType: "ALLOW",
 *       host: "*",
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Cluster-wide ACL
 * ```typescript
 * const acl = yield* GCP.ManagedKafka.ClustersAcl("ClusterAcl", {
 *   cluster: cluster.name,
 *   aclId: "cluster",
 *   aclEntries: [
 *     {
 *       principal: "User:client@my-project.iam.gserviceaccount.com",
 *       operation: "CLUSTER_ACTION",
 *       permissionType: "ALLOW",
 *       host: "*",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category ManagedKafka
 */
export const ClustersAcl = Resource<ClustersAcl>(
  "GCP.ManagedKafka.ClustersAcl",
);

export class ClustersAclNotResolved extends Data.TaggedError(
  "GCP.ManagedKafka.ClustersAclNotResolved",
)<{
  name: string;
}> {}

const clusterOf = (cluster: string, project: string, location: string) =>
  expandParent(cluster, project, location, "clusters");

const resourceName = (cluster: string, aclId: string) =>
  `${cluster}/acls/${aclId}`;

const entriesOf = (
  entries: readonly kafka.AclEntry[] | undefined,
): AclEntry[] =>
  (entries ?? []).map((entry) => ({
    operation: entry.operation,
    host: entry.host ?? "*",
    permissionType: entry.permissionType,
    principal: entry.principal,
  }));

const entriesKey = (entries: readonly AclEntry[] | undefined) =>
  fingerprint(
    entriesOf(entries).map((entry) => ({
      operation: (entry.operation ?? "").toUpperCase(),
      host: entry.host ?? "*",
      permissionType: (entry.permissionType ?? "").toUpperCase(),
      principal: entry.principal ?? "",
    })),
  );

const toAttrs = (acl: kafka.Acl, project: string) => {
  const name = acl.name ?? "";
  const parsed = parseName(name, "acls");
  return {
    name,
    aclId: parsed.id,
    cluster: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    aclEntries: entriesOf(acl.aclEntries),
    patternType: acl.patternType,
    resourceName: acl.resourceName,
    resourceType: acl.resourceType,
    etag: acl.etag,
  };
};

const toAclId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    if (existing !== undefined) return existing;
    const topicId = yield* toPhysicalId(id, undefined, undefined, "topic");
    return `topic/${topicId}`;
  });

export const ClustersAclProvider = () =>
  Provider.succeed(ClustersAcl, {
    stables: [
      "name",
      "aclId",
      "cluster",
      "project",
      "location",
      "patternType",
      "resourceName",
      "resourceType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousId: olds?.aclId ?? output?.aclId,
        nextId: news.aclId ?? olds?.aclId ?? output?.aclId,
        previousParent: olds?.cluster ?? output?.cluster,
        nextParent: clusterOf(news.cluster, env.project, location),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const aclId = yield* toAclId(id, olds?.aclId, output?.aclId);
      const cluster =
        olds?.cluster !== undefined
          ? clusterOf(olds.cluster, env.project, location)
          : (output?.cluster ?? "");
      const name =
        output?.name ??
        (cluster.length > 0 ? resourceName(cluster, aclId) : "");
      const existing = yield* getAcl(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return output !== undefined || olds !== undefined
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const clusters = yield* listAlchemyClusters(env.project, env.region);
        const acls = yield* Effect.forEach(
          clusters.filter((cluster) => (cluster.name ?? "").length > 0),
          (cluster: kafka.Cluster) =>
            collectPages(
              kafka.listProjectsLocationsClustersAcls.pages({
                parent: cluster.name!,
                pageSize: 1000,
              }),
              (page) => page.acls,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as kafka.Acl[]),
              ),
            ),
          { concurrency: 4 },
        );
        return acls.flat().map((acl) => toAttrs(acl, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const cluster = clusterOf(news.cluster, env.project, location);
      const aclId = yield* toAclId(id, news.aclId, output?.aclId);
      const name = output?.name ?? resourceName(cluster, aclId);
      const aclEntries = news.aclEntries.map((entry) => ({
        operation: entry.operation,
        host: entry.host ?? "*",
        permissionType: entry.permissionType,
        principal: entry.principal,
      }));

      let current = yield* getAcl(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          kafka
            .createProjectsLocationsClustersAcls({
              parent: cluster,
              aclId,
              body: { aclEntries },
            })
            .pipe(Effect.catchTag("Conflict", () => getAcl(name))),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ClustersAclNotResolved({ name });
      }

      if (entriesKey(current.aclEntries) !== entriesKey(aclEntries)) {
        current = yield* kafka.patchProjectsLocationsClustersAcls({
          name,
          updateMask: "acl_entries",
          body: {
            aclEntries,
            etag: current.etag,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* kafka
        .deleteProjectsLocationsClustersAcls({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "AclClusterNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });
