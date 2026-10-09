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
  VMWARE_NAME_LENGTH,
  collectPages,
  createInternalLabels,
  desiredAnnotations,
  differs,
  encodeOwnership,
  expandParent,
  fieldMask,
  isOwned,
  listAtLocation,
  listAtNested,
  listChildrenOf,
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
  VmwareNodeConfig,
  VmwareNodePoolAutoscalingConfig,
} from "./types.ts";

const COLLECTION = "vmwareNodePools";
const PARENT_COLLECTION = "vmwareClusters";

export type VmwareClustersVmwareNodePoolProps = {
  /**
   * Parent VMware user cluster. Full name
   * `projects/{project}/locations/{location}/vmwareClusters/{cluster}`
   * or the cluster id (combined with `location`). Immutable — changing
   * it replaces the node pool.
   */
  vmwareCluster: string;
  /**
   * Region used when `vmwareCluster` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Node pool id (the `{vmwareNodePool}` segment). If omitted, a unique
   * RFC1123 name is generated. Max 40 characters. Immutable — changing
   * it replaces the pool.
   */
  vmwareNodePoolId?: string;
  /**
   * Node configuration (image type, replicas, CPU, memory).
   */
  config: VmwareNodeConfig;
  /**
   * Display name. Node pools have no GCP labels field, so Alchemy stamps
   * ownership into annotations and a `[alchemy …]` displayName prefix
   * and strips both from attributes.
   */
  displayName?: string;
  /**
   * Anthos version for the node pool. Defaults to the user cluster version.
   */
  onPremVersion?: string;
  /**
   * Node pool autoscaling bounds.
   */
  nodePoolAutoscaling?: VmwareNodePoolAutoscalingConfig;
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

export type VmwareClustersVmwareNodePool = Resource<
  "GCP.GKEOnPrem.VmwareClustersVmwareNodePool",
  VmwareClustersVmwareNodePoolProps,
  {
    /** Full resource name. */
    name: string;
    /** Node pool id (last path segment). */
    vmwareNodePoolId: string;
    /** Parent cluster resource name. */
    vmwareCluster: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Node configuration. */
    config: gkeonprem.VmwareNodeConfig | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Anthos version. */
    onPremVersion: string | undefined;
    /** Autoscaling bounds. */
    nodePoolAutoscaling: gkeonprem.VmwareNodePoolAutoscalingConfig | undefined;
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
 * A worker node pool on an Anthos on VMware user cluster.
 *
 * Node pools have no GCP labels field, so Alchemy stamps ownership into
 * annotations and a `[alchemy …]` displayName prefix for `list` / nuke.
 * Pool id, location, and parent cluster are identity — changing them
 * replaces the pool. Config, display name, version, and autoscaling
 * update in place.
 *
 * ### Creating a VMware Node Pool
 * **Example:** Ubuntu worker pool
 * ```typescript
 * const pool = yield* GCP.GKEOnPrem.VmwareClustersVmwareNodePool("Workers", {
 *   vmwareCluster: cluster.name,
 *   config: {
 *     imageType: "ubuntu_containerd",
 *     replicas: "3",
 *     cpus: "4",
 *     memoryMb: "8192",
 *   },
 *   displayName: "app workers",
 * });
 * ```
 *
 * ### Updating a VMware Node Pool
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Scale replicas
 * ```typescript
 * const pool = yield* GCP.GKEOnPrem.VmwareClustersVmwareNodePool("Workers", {
 *   vmwareCluster: cluster.name,
 *   config: {
 *     imageType: "ubuntu_containerd",
 *     replicas: "5",
 *     cpus: "4",
 *     memoryMb: "8192",
 *   },
 *   displayName: "app workers v2",
 * });
 * ```
 *
 * @resource
 * @category GKEOnPrem
 */
export const VmwareClustersVmwareNodePool =
  Resource<VmwareClustersVmwareNodePool>(
    "GCP.GKEOnPrem.VmwareClustersVmwareNodePool",
  );

const resourceName = (cluster: string, vmwareNodePoolId: string) =>
  `${cluster}/${COLLECTION}/${vmwareNodePoolId}`;

const toAttrs = (
  item: gkeonprem.VmwareNodePool,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const ownership = parseOwnership(item.displayName);
  const annotations = userLabels(item.annotations);
  return {
    name,
    vmwareNodePoolId: parsed.id,
    vmwareCluster: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    config: item.config,
    displayName: ownership.text,
    onPremVersion: item.onPremVersion,
    nodePoolAutoscaling: item.nodePoolAutoscaling,
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
    .getProjectsLocationsVmwareClustersVmwareNodePools({
      name,
      view: "FULL",
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listChildren = (parent: string) =>
  collectPages(
    gkeonprem.listProjectsLocationsVmwareClustersVmwareNodePools.pages({
      parent,
      pageSize: 1000,
      view: "FULL",
    }),
    (page): readonly gkeonprem.VmwareNodePool[] | undefined =>
      page.vmwareNodePools,
  );

const listOwned = (project: string, region: string) =>
  listAtNested(project, region, `${PARENT_COLLECTION}/-`, listChildren).pipe(
    Effect.flatMap((items) =>
      items.length > 0
        ? Effect.succeed(items)
        : listChildrenOf(
            listAtLocation(project, region, (parent) =>
              collectPages(
                gkeonprem.listProjectsLocationsVmwareClusters.pages({
                  parent,
                  pageSize: 1000,
                  view: "BASIC",
                }),
                (page): readonly gkeonprem.VmwareCluster[] | undefined =>
                  page.vmwareClusters,
              ),
            ),
            (cluster: gkeonprem.VmwareCluster) => cluster.name,
            listChildren,
          ),
    ),
    Effect.map((items) =>
      items.filter((item: gkeonprem.VmwareNodePool) =>
        isOwned(item.annotations, item.displayName),
      ),
    ),
  );

export const VmwareClustersVmwareNodePoolProvider = () =>
  Provider.succeed(VmwareClustersVmwareNodePool, {
    stables: [
      "name",
      "vmwareNodePoolId",
      "vmwareCluster",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.vmwareNodePoolId ?? output?.vmwareNodePoolId,
        nextId: news.vmwareNodePoolId
          ? rfc1035(news.vmwareNodePoolId, "vmwarenodepool", VMWARE_NAME_LENGTH)
          : (olds?.vmwareNodePoolId ?? output?.vmwareNodePoolId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.vmwareCluster ?? output?.vmwareCluster,
        nextParent: news.vmwareCluster,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const vmwareNodePoolId = yield* toPhysicalId(
        id,
        olds?.vmwareNodePoolId,
        output?.vmwareNodePoolId,
        "vmwarenodepool",
        VMWARE_NAME_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const cluster = expandParent(
        olds?.vmwareCluster ?? output?.vmwareCluster ?? "",
        env.project,
        location,
        PARENT_COLLECTION,
      );
      const name = output?.name ?? resourceName(cluster, vmwareNodePoolId);
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
        return items.map((item: gkeonprem.VmwareNodePool) =>
          toAttrs(item, env.project, env.region),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const vmwareNodePoolId = yield* toPhysicalId(
        id,
        news.vmwareNodePoolId,
        output?.vmwareNodePoolId,
        "vmwarenodepool",
        VMWARE_NAME_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const cluster = expandParent(
        news.vmwareCluster,
        env.project,
        location,
        PARENT_COLLECTION,
      );
      const name = resourceName(cluster, vmwareNodePoolId);
      const ownership = yield* createInternalLabels(id);
      const annotations = desiredAnnotations(
        ownership,
        news.labels,
        news.annotations,
      );
      const displayName = encodeOwnership(ownership, news.displayName);
      const body: gkeonprem.VmwareNodePool = {
        config: news.config,
        displayName,
        onPremVersion: news.onPremVersion,
        nodePoolAutoscaling: news.nodePoolAutoscaling,
        annotations,
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkeonprem
          .createProjectsLocationsVmwareClustersVmwareNodePools({
            parent: cluster,
            vmwareNodePoolId,
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
        differs(current.config, news.config) && "config",
        differs(current.onPremVersion, news.onPremVersion) && "onPremVersion",
        differs(current.nodePoolAutoscaling, news.nodePoolAutoscaling) &&
          "nodePoolAutoscaling",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* gkeonprem.patchProjectsLocationsVmwareClustersVmwareNodePools({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              ...body,
              etag: current.etag,
            },
          });
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
        .deleteProjectsLocationsVmwareClustersVmwareNodePools({
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
