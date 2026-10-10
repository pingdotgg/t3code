import * as gkeonprem from "@distilled.cloud/gcp/gkeonprem_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  ResourceNotResolved,
  collectPages,
  createInternalLabels,
  desiredAnnotations,
  differs,
  encodeOwnership,
  expandParent,
  fieldMask,
  isOwned,
  listAtNested,
  listChildrenOf,
  listAtLocation,
  normalizeLocation,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  rfc1035,
  sameText,
  textState,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";
import type {
  BareMetalNodePoolConfig,
  BareMetalNodePoolUpgradePolicy,
} from "./types.ts";

const COLLECTION = "bareMetalNodePools";
const PARENT_COLLECTION = "bareMetalClusters";

export type BareMetalClustersBareMetalNodePoolProps = {
  /**
   * Parent bare metal user cluster. Full name
   * `projects/{project}/locations/{location}/bareMetalClusters/{cluster}`
   * or the cluster id (combined with `location`). Immutable — changing
   * it replaces the node pool.
   */
  bareMetalCluster: string;
  /**
   * Region used when `bareMetalCluster` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Node pool id (the `{bareMetalNodePool}` segment). If omitted, a unique
   * RFC1035 name is generated. Immutable — changing it replaces the pool.
   */
  bareMetalNodePoolId?: string;
  /**
   * Node pool configuration, including machine addresses.
   */
  nodePoolConfig: BareMetalNodePoolConfig;
  /**
   * Display name. Node pools have no GCP labels field, so Alchemy stamps
   * ownership into annotations and a `[alchemy …]` displayName prefix
   * and strips both from attributes.
   */
  displayName?: string;
  /**
   * Worker node pool upgrade policy.
   */
  upgradePolicy?: BareMetalNodePoolUpgradePolicy;
  /**
   * Kubernetes-style annotations. Alchemy ownership keys are merged in.
   */
  annotations?: Record<string, string>;
  /**
   * User labels stored as annotations (keys sanitized like GCP labels).
   * Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type BareMetalClustersBareMetalNodePool = Resource<
  "GCP.GKEOnPrem.BareMetalClustersBareMetalNodePool",
  BareMetalClustersBareMetalNodePoolProps,
  {
    /** Full resource name. */
    name: string;
    /** Node pool id (last path segment). */
    bareMetalNodePoolId: string;
    /** Parent cluster resource name. */
    bareMetalCluster: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Node pool configuration. */
    nodePoolConfig: gkeonprem.BareMetalNodePoolConfig | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Upgrade policy. */
    upgradePolicy: gkeonprem.BareMetalNodePoolUpgradePolicy | undefined;
    /** User annotations (Alchemy ownership keys stripped). */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership keys stripped). */
    labels: Record<string, string>;
    /** Server-reported state. */
    state: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** Whether a change is in flight. */
    reconciling: boolean | undefined;
    /** Controller error message. */
    errorMessage: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 deletion timestamp. */
    deleteTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A worker node pool on an Anthos on bare metal user cluster.
 *
 * Node pools have no GCP labels field, so Alchemy stamps ownership into
 * annotations and a `[alchemy …]` displayName prefix for `list` / nuke.
 * Pool id, location, and parent cluster are identity — changing them
 * replaces the pool. Config, display name, and upgrade policy update
 * in place.
 *
 * ### Creating a Bare Metal Node Pool
 * **Example:** Worker pool with two machines
 * ```typescript
 * const pool = yield* GCP.GKEOnPrem.BareMetalClustersBareMetalNodePool(
 *   "Workers",
 *   {
 *     bareMetalCluster: cluster.name,
 *     nodePoolConfig: {
 *       nodeConfigs: [
 *         { nodeIp: "10.200.0.11" },
 *         { nodeIp: "10.200.0.12" },
 *       ],
 *     },
 *     displayName: "app workers",
 *   },
 * );
 * ```
 *
 * ### Updating a Bare Metal Node Pool
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Add a machine
 * ```typescript
 * const pool = yield* GCP.GKEOnPrem.BareMetalClustersBareMetalNodePool(
 *   "Workers",
 *   {
 *     bareMetalCluster: cluster.name,
 *     nodePoolConfig: {
 *       nodeConfigs: [
 *         { nodeIp: "10.200.0.11" },
 *         { nodeIp: "10.200.0.12" },
 *         { nodeIp: "10.200.0.13" },
 *       ],
 *     },
 *     displayName: "app workers v2",
 *   },
 * );
 * ```
 *
 * @resource
 * @category GKEOnPrem
 */
export const BareMetalClustersBareMetalNodePool =
  Resource<BareMetalClustersBareMetalNodePool>(
    "GCP.GKEOnPrem.BareMetalClustersBareMetalNodePool",
  );

const resourceName = (cluster: string, bareMetalNodePoolId: string) =>
  `${cluster}/${COLLECTION}/${bareMetalNodePoolId}`;

const toAttrs = (
  item: gkeonprem.BareMetalNodePool,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(item.displayName);
  const annotations = userLabels(item.annotations);
  return {
    name,
    bareMetalNodePoolId: parsed.id,
    bareMetalCluster: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    nodePoolConfig: item.nodePoolConfig,
    displayName: ownership.text,
    upgradePolicy: item.upgradePolicy,
    annotations,
    labels: annotations,
    state: textState(item.state),
    uid: item.uid,
    reconciling: item.reconciling,
    errorMessage: item.status?.errorMessage,
    createTime: item.createTime,
    updateTime: item.updateTime,
    deleteTime: item.deleteTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  gkeonprem
    .getProjectsLocationsBareMetalClustersBareMetalNodePools({
      name,
      view: "FULL",
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listChildren = (parent: string) =>
  collectPages(
    gkeonprem.listProjectsLocationsBareMetalClustersBareMetalNodePools.pages({
      parent,
      pageSize: 1000,
      view: "FULL",
    }),
    (page): readonly gkeonprem.BareMetalNodePool[] | undefined =>
      page.bareMetalNodePools,
  );

const listOwned = (project: string, region: string) =>
  listAtNested(project, region, `${PARENT_COLLECTION}/-`, listChildren).pipe(
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : listChildrenOf(
            listAtLocation(project, region, (parent) =>
              collectPages(
                gkeonprem.listProjectsLocationsBareMetalClusters.pages({
                  parent,
                  pageSize: 1000,
                  view: "BASIC",
                }),
                (page): readonly gkeonprem.BareMetalCluster[] | undefined =>
                  page.bareMetalClusters,
              ),
            ),
            (cluster: gkeonprem.BareMetalCluster) => cluster.name,
            listChildren,
          ),
    ),
    Effect.map((items) =>
      items.filter((item: gkeonprem.BareMetalNodePool) =>
        isOwned(item.annotations, item.displayName),
      ),
    ),
  );

export const BareMetalClustersBareMetalNodePoolProvider = () =>
  Provider.succeed(BareMetalClustersBareMetalNodePool, {
    stables: [
      "name",
      "bareMetalNodePoolId",
      "bareMetalCluster",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.bareMetalNodePoolId ?? output?.bareMetalNodePoolId,
        nextId: news.bareMetalNodePoolId
          ? rfc1035(news.bareMetalNodePoolId, "baremetalnodepool")
          : (olds?.bareMetalNodePoolId ?? output?.bareMetalNodePoolId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.bareMetalCluster ?? output?.bareMetalCluster,
        nextParent: news.bareMetalCluster,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const bareMetalNodePoolId = yield* toPhysicalId(
        id,
        olds?.bareMetalNodePoolId,
        output?.bareMetalNodePoolId,
        "baremetalnodepool",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const cluster = expandParent(
        olds?.bareMetalCluster ?? output?.bareMetalCluster ?? "",
        env.project,
        location,
        PARENT_COLLECTION,
      );
      const name = output?.name ?? resourceName(cluster, bareMetalNodePoolId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      const fromName = parseOwnership(existing.displayName).labels;
      const owned =
        (yield* hasAlchemyLabels(id, tagRecord(existing.annotations))) ||
        (yield* hasAlchemyLabels(id, fromName));
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item: gkeonprem.BareMetalNodePool) =>
          toAttrs(item, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const bareMetalNodePoolId = yield* toPhysicalId(
        id,
        news.bareMetalNodePoolId,
        output?.bareMetalNodePoolId,
        "baremetalnodepool",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const cluster = expandParent(
        news.bareMetalCluster,
        env.project,
        location,
        PARENT_COLLECTION,
      );
      const name = resourceName(cluster, bareMetalNodePoolId);
      const ownership = yield* createInternalLabels(id);
      const annotations = desiredAnnotations(
        ownership,
        news.labels,
        news.annotations,
      );
      const displayName = encodeOwnership(ownership, news.displayName);
      const body: gkeonprem.BareMetalNodePool = {
        nodePoolConfig: news.nodePoolConfig,
        displayName,
        upgradePolicy: news.upgradePolicy,
        annotations,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkeonprem
          .createProjectsLocationsBareMetalClustersBareMetalNodePools({
            parent: cluster,
            bareMetalNodePoolId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const mask = fieldMask([
        differs(current.annotations, annotations) && "annotations",
        !sameText(parseOwnership(current.displayName).text, news.displayName) &&
          "displayName",
        differs(current.nodePoolConfig, news.nodePoolConfig) &&
          "nodePoolConfig",
        differs(current.upgradePolicy, news.upgradePolicy) && "upgradePolicy",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* gkeonprem.patchProjectsLocationsBareMetalClustersBareMetalNodePools(
            {
              name: current.name ?? name,
              updateMask: mask,
              body: {
                ...body,
                etag: current.etag,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }
      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* gkeonprem
        .deleteProjectsLocationsBareMetalClustersBareMetalNodePools({
          name: output.name,
          allowMissing: true,
          etag: output.etag,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
