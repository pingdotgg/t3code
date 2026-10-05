import * as workstations from "@distilled.cloud/gcp/workstations_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  networkName,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  stringMap,
  subnetworkName,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DomainConfig = {
  /**
   * Domain used by Workstations for HTTP ingress. Immutable.
   */
  domain?: string;
};

export type GatewayConfig = {
  /**
   * Whether HTTP/2 is enabled for this workstation cluster.
   * @default false
   */
  http2Enabled?: boolean;
};

export type PrivateClusterConfig = {
  /**
   * Whether the Workstations endpoint is private. Immutable.
   * @default false
   */
  enablePrivateEndpoint?: boolean;
  /**
   * Additional projects allowed to attach to the cluster's service
   * attachment. The cluster project and VPC host project are allowed by
   * default.
   */
  allowedProjects?: string[];
};

export type WorkstationClusterProps = {
  /**
   * Cluster id (the `{workstationCluster}` segment of
   * `projects/{project}/locations/{location}/workstationClusters/{workstationCluster}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the cluster.
   */
  workstationClusterId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the cluster. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * VPC network. Full name
   * `projects/{project}/global/networks/{network}` or a network id.
   * Immutable — changing it replaces the cluster.
   * @default "default"
   */
  network?: string;
  /**
   * Subnetwork. Full name
   * `projects/{project}/regions/{region}/subnetworks/{subnetwork}` or a
   * subnetwork id (combined with `location`). Immutable — changing it
   * replaces the cluster.
   * @default "default"
   */
  subnetwork?: string;
  /**
   * Human-readable display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically
   * and propagated to the underlying Compute Engine resources.
   */
  labels?: Record<string, string>;
  /**
   * Client-specified annotations.
   */
  annotations?: Record<string, string>;
  /**
   * Resource Manager tags bound at create time. Immutable.
   */
  tags?: Record<string, string>;
  /**
   * Launch URL for unstarted workstations in this cluster.
   */
  workstationLaunchUrl?: string;
  /**
   * Redirect URL for unauthorized requests received by workstation VMs.
   */
  workstationAuthorizationUrl?: string;
  /**
   * Configuration options for a custom domain. Immutable.
   */
  domainConfig?: DomainConfig;
  /**
   * Cluster HTTP gateway options.
   */
  gatewayConfig?: GatewayConfig;
  /**
   * Private cluster configuration. `enablePrivateEndpoint` is immutable.
   */
  privateClusterConfig?: PrivateClusterConfig;
};

export type WorkstationCluster = Resource<
  "GCP.Workstations.WorkstationCluster",
  WorkstationClusterProps,
  {
    /** Full resource name. */
    name: string;
    /** Cluster id (last path segment). */
    workstationClusterId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** VPC network name. */
    network: string | undefined;
    /** Subnetwork name. */
    subnetwork: string | undefined;
    /** Human-readable display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Client-specified annotations. */
    annotations: Record<string, string>;
    /** Launch URL for unstarted workstations. */
    workstationLaunchUrl: string | undefined;
    /** Redirect URL for unauthorized workstation requests. */
    workstationAuthorizationUrl: string | undefined;
    /** Custom domain configuration. */
    domainConfig: DomainConfig | undefined;
    /** HTTP gateway configuration. */
    gatewayConfig: GatewayConfig | undefined;
    /** Private cluster configuration. */
    privateClusterConfig: PrivateClusterConfig | undefined;
    /** Private IP of the cluster control plane. */
    controlPlaneIp: string | undefined;
    /** Whether the cluster is currently reconciling. */
    reconciling: boolean;
    /** Whether the cluster is in degraded mode. */
    degraded: boolean;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Workstations cluster — a regional group of workstations
 * attached to a VPC network.
 *
 * Changing `workstationClusterId`, `location`, `network`, `subnetwork`,
 * `domainConfig`, `tags`, or `privateClusterConfig.enablePrivateEndpoint`
 * replaces the cluster. Display name, labels, annotations, launch URLs,
 * gateway config, and `allowedProjects` update in place.
 *
 * ### Creating a Cluster
 * **Example:** Generated name on the default VPC
 * ```typescript
 * const cluster = yield* GCP.Workstations.WorkstationCluster("Dev", {});
 * ```
 *
 * **Example:** Explicit id, network, and labels
 * ```typescript
 * const cluster = yield* GCP.Workstations.WorkstationCluster("Dev", {
 *   workstationClusterId: "app-dev",
 *   location: "us-central1",
 *   network: "default",
 *   subnetwork: "default",
 *   displayName: "app-dev workstations",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Cluster
 * **Example:** Display name and labels
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const cluster = yield* GCP.Workstations.WorkstationCluster("Dev", {
 *   displayName: "app-dev workstations v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category Workstations
 */
export const WorkstationCluster = Resource<WorkstationCluster>(
  "GCP.Workstations.WorkstationCluster",
);

const resourceName = (
  project: string,
  location: string,
  workstationClusterId: string,
) =>
  `projects/${project}/locations/${location}/workstationClusters/${workstationClusterId}`;

const toDomain = (
  config: workstations.DomainConfig | DomainConfig | undefined,
): DomainConfig | undefined =>
  config === undefined ? undefined : { domain: config.domain };

const toGateway = (
  config: workstations.GatewayConfig | GatewayConfig | undefined,
): GatewayConfig | undefined =>
  config === undefined ? undefined : { http2Enabled: config.http2Enabled };

const toPrivate = (
  config: workstations.PrivateClusterConfig | PrivateClusterConfig | undefined,
): PrivateClusterConfig | undefined =>
  config === undefined
    ? undefined
    : {
        enablePrivateEndpoint: config.enablePrivateEndpoint,
        allowedProjects: config.allowedProjects,
      };

const toAttrs = (
  item: workstations.WorkstationCluster,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "workstationClusters", region);
  return {
    name,
    workstationClusterId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    network: item.network,
    subnetwork: item.subnetwork,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    annotations: stringMap(item.annotations) ?? {},
    workstationLaunchUrl: item.workstationLaunchUrl,
    workstationAuthorizationUrl: item.workstationAuthorizationUrl,
    domainConfig: toDomain(item.domainConfig),
    gatewayConfig: toGateway(item.gatewayConfig),
    privateClusterConfig: toPrivate(item.privateClusterConfig),
    controlPlaneIp: item.controlPlaneIp,
    reconciling: item.reconciling === true,
    degraded: item.degraded === true,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  workstations
    .getProjectsLocationsWorkstationClusters({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      workstations.listProjectsLocationsWorkstationClusters.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.workstationClusters,
      (item) => item.labels,
    ),
  );

export const WorkstationClusterProvider = () =>
  Provider.succeed(WorkstationCluster, {
    stables: [
      "name",
      "workstationClusterId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousNetwork = olds?.network ?? output?.network;
      const previousSubnetwork = olds?.subnetwork ?? output?.subnetwork;
      const previousPrivate =
        olds?.privateClusterConfig ?? output?.privateClusterConfig;
      const previousDomain = olds?.domainConfig ?? output?.domainConfig;
      const previousTags = olds?.tags;
      return replaceOnIdentity({
        previousId: olds?.workstationClusterId ?? output?.workstationClusterId,
        nextId:
          news.workstationClusterId ??
          olds?.workstationClusterId ??
          output?.workstationClusterId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousNetwork !== undefined &&
            news.network !== undefined &&
            !sameText(previousNetwork, news.network) &&
            !previousNetwork.endsWith(`/${news.network}`)) ||
          (previousSubnetwork !== undefined &&
            news.subnetwork !== undefined &&
            !sameText(previousSubnetwork, news.subnetwork) &&
            !previousSubnetwork.endsWith(`/${news.subnetwork}`)) ||
          (previousPrivate?.enablePrivateEndpoint !== undefined &&
            news.privateClusterConfig?.enablePrivateEndpoint !== undefined &&
            previousPrivate.enablePrivateEndpoint !==
              news.privateClusterConfig.enablePrivateEndpoint) ||
          (previousDomain?.domain !== undefined &&
            news.domainConfig?.domain !== undefined &&
            previousDomain.domain !== news.domainConfig.domain) ||
          (previousTags !== undefined &&
            news.tags !== undefined &&
            fingerprint(previousTags) !== fingerprint(news.tags)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const workstationClusterId = yield* toPhysicalId(
        id,
        olds?.workstationClusterId,
        output?.workstationClusterId,
        "cluster",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, workstationClusterId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      // A resource we recorded is ours even while GCP hides its labels
      // (clusters report none while `reconciling`), so destroy can still
      // clean it up.
      if (output !== undefined && output.name === existing.name) return attrs;
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const workstationClusterId = yield* toPhysicalId(
        id,
        news.workstationClusterId,
        output?.workstationClusterId,
        "cluster",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, workstationClusterId);
      const network = networkName(news.network, env.project);
      const subnetwork = subnetworkName(news.subnetwork, env.project, location);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = stringMap(news.annotations);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* workstations
          .createProjectsLocationsWorkstationClusters({
            parent: parentOf(env.project, location),
            workstationClusterId,
            body: {
              network,
              subnetwork,
              displayName: news.displayName,
              labels: desiredLabels,
              annotations: desiredAnnotations,
              tags: stringMap(news.tags),
              workstationLaunchUrl: news.workstationLaunchUrl,
              workstationAuthorizationUrl: news.workstationAuthorizationUrl,
              domainConfig: news.domainConfig,
              gatewayConfig: news.gatewayConfig,
              privateClusterConfig: news.privateClusterConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const observedPrivate = toPrivate(current.privateClusterConfig);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.displayName, news.displayName) && "displayName",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        // Both URLs default server-side; only converge them when set.
        news.workstationLaunchUrl !== undefined &&
          !sameText(current.workstationLaunchUrl, news.workstationLaunchUrl) &&
          "workstationLaunchUrl",
        news.workstationAuthorizationUrl !== undefined &&
          !sameText(
            current.workstationAuthorizationUrl,
            news.workstationAuthorizationUrl,
          ) &&
          "workstationAuthorizationUrl",
        news.gatewayConfig !== undefined &&
          fingerprint(toGateway(current.gatewayConfig)) !==
            fingerprint(toGateway(news.gatewayConfig)) &&
          "gatewayConfig",
        fingerprint(observedPrivate?.allowedProjects) !==
          fingerprint(news.privateClusterConfig?.allowedProjects) &&
          "privateClusterConfig.allowedProjects",
      ]);

      if (mask.length > 0) {
        const operation = yield* workstations
          .patchProjectsLocationsWorkstationClusters({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              labels: desiredLabels,
              displayName: news.displayName,
              annotations: desiredAnnotations,
              workstationLaunchUrl: news.workstationLaunchUrl,
              workstationAuthorizationUrl: news.workstationAuthorizationUrl,
              gatewayConfig: news.gatewayConfig,
              privateClusterConfig: {
                allowedProjects: news.privateClusterConfig?.allowedProjects,
              },
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* workstations
        .deleteProjectsLocationsWorkstationClusters({
          name: output.name,
          force: true,
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
        // NOT_FOUND (5): already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
