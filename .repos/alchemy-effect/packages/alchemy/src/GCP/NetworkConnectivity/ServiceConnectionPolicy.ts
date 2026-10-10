import * as networkconnectivity from "@distilled.cloud/gcp/networkconnectivity_v1";
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
  NetworkConnectivityNotResolved,
  canonicalizeLink,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  sameJson,
  toNetworkResource,
  toPhysicalId,
  toSubnetworkResource,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "serviceConnectionPolicies";

export type ServiceConnectionPolicySubnetworkMode =
  | networkconnectivity.CreateProjectsLocationsServiceConnectionPoliciesSubnetworkModeEnum
  | (string & {});
export type ServiceConnectionPolicyIpStack =
  | networkconnectivity.CreateProjectsLocationsServiceConnectionPoliciesAutoSubnetworkConfig_ipStackEnum
  | (string & {});
export type PscConfigProducerInstanceLocation =
  | networkconnectivity.PscConfigProducerInstanceLocationEnum
  | (string & {});

export type PscConfig = {
  /**
   * Subnetwork resource paths used for IPAM
   * (`projects/{project}/regions/{region}/subnetworks/{subnetwork}`).
   */
  subnetworks?: string[];
  /**
   * Max number of PSC connections for this policy (int64 string).
   */
  limit?: string;
  /**
   * Authorization mechanism for producer instance location.
   */
  producerInstanceLocation?: PscConfigProducerInstanceLocation;
  /**
   * Projects, folders, or organizations the producer instance may live
   * in, e.g. `"projects/my-project"`.
   */
  allowedGoogleProducersResourceHierarchyLevel?: string[];
};

export type AutoSubnetworkConfig = {
  /** Requested IP stack. */
  ipStack?: ServiceConnectionPolicyIpStack;
  /** Desired prefix length for the auto-created subnet. */
  prefixLength?: number;
  /** CIDR spaces to search for a free range. */
  allocRangeSpace?: string[];
};

export type AutoCreatedSubnetworkInfo = {
  internalRange?: string;
  internalRangeRef?: string;
  subnetwork?: string;
  subnetworkRef?: string;
  delinked?: boolean;
};

export type ServiceConnectionPolicyProps = {
  /**
   * Policy id (the `{service_connection_policy}` segment). If omitted, a
   * unique name is generated. Immutable — changing it replaces the
   * policy.
   */
  serviceConnectionPolicyId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * policy. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Consumer VPC
   * (`projects/{project}/global/networks/{network}` or a Compute
   * self-link). Immutable — changing it replaces the policy.
   */
  network: string;
  /**
   * Service class identifier, e.g. `"gcp-memorystore-redis"` or
   * `"gcp-cloud-sql"`.
   */
  serviceClass: string;
  /**
   * PSC connection configuration (subnets, connection limit, …).
   */
  pscConfig?: PscConfig;
  /**
   * Subnetwork mode. `USER_PROVIDED` uses `pscConfig.subnetworks`;
   * `AUTO_CREATED` allocates a subnet from `autoSubnetworkConfig`.
   * Create-only.
   */
  subnetworkMode?: ServiceConnectionPolicySubnetworkMode;
  /**
   * Auto-created subnet options. Create-only; used when
   * `subnetworkMode` is `AUTO_CREATED`.
   */
  autoSubnetworkConfig?: AutoSubnetworkConfig;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type ServiceConnectionPolicy = Resource<
  "GCP.NetworkConnectivity.ServiceConnectionPolicy",
  ServiceConnectionPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/serviceConnectionPolicies/{id}`. */
    name: string;
    /** Policy id (last path segment). */
    serviceConnectionPolicyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Consumer VPC resource path. */
    network: string | undefined;
    /** Service class identifier. */
    serviceClass: string | undefined;
    /** PSC configuration. */
    pscConfig: PscConfig | undefined;
    /** Infrastructure used for connections (`PSC`, …). */
    infrastructure: string | undefined;
    /** Auto-created subnet info, if any. */
    autoCreatedSubnetInfo: AutoCreatedSubnetworkInfo | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A PSC Service Connection Policy that allows a consumer VPC to connect
 * to a producer service class (Cloud SQL, Memorystore, …).
 *
 * Changing `serviceConnectionPolicyId`, `location`, or `network`
 * replaces the policy. Description, labels, `serviceClass`, and
 * `pscConfig` update in place.
 *
 * ### Creating a ServiceConnectionPolicy
 * **Example:** User-provided subnet
 * ```typescript
 * const network = yield* GCP.Compute.Network("AppVpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const subnet = yield* GCP.Compute.Subnetwork("PscSubnet", {
 *   network: network.selfLink ?? network.networkName,
 *   ipCidrRange: "10.20.0.0/24",
 * });
 * const policy = yield* GCP.NetworkConnectivity.ServiceConnectionPolicy(
 *   "Redis",
 *   {
 *     serviceClass: "gcp-memorystore-redis",
 *     network: network.selfLink ?? network.networkName,
 *     pscConfig: {
 *       subnetworks: [subnet.selfLink ?? subnet.subnetworkName],
 *     },
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * ### Updating a ServiceConnectionPolicy
 * **Example:** Description, labels, and connection limit
 * ```typescript
 * const policy = yield* GCP.NetworkConnectivity.ServiceConnectionPolicy(
 *   "Redis",
 *   {
 *     serviceClass: "gcp-memorystore-redis",
 *     network: network.selfLink ?? network.networkName,
 *     description: "redis psc v2",
 *     pscConfig: {
 *       subnetworks: [subnet.selfLink ?? subnet.subnetworkName],
 *       limit: "4",
 *     },
 *     labels: { env: "prod", role: "psc" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkConnectivity
 */
export const ServiceConnectionPolicy = Resource<ServiceConnectionPolicy>(
  "GCP.NetworkConnectivity.ServiceConnectionPolicy",
);

const resourceName = (
  project: string,
  location: string,
  serviceConnectionPolicyId: string,
) =>
  `projects/${project}/locations/${location}/serviceConnectionPolicies/${serviceConnectionPolicyId}`;

const toPscConfig = (
  config: PscConfig | networkconnectivity.PscConfig | undefined,
  project: string,
  location: string,
): PscConfig | undefined => {
  if (config === undefined) return undefined;
  return {
    subnetworks: (config.subnetworks ?? []).map((subnetwork) =>
      toSubnetworkResource(project, location, subnetwork),
    ),
    limit: config.limit,
    producerInstanceLocation: config.producerInstanceLocation,
    allowedGoogleProducersResourceHierarchyLevel:
      config.allowedGoogleProducersResourceHierarchyLevel
        ? [...config.allowedGoogleProducersResourceHierarchyLevel]
        : undefined,
  };
};

const toAutoCreated = (
  info: networkconnectivity.AutoCreatedSubnetworkInfo | undefined,
): AutoCreatedSubnetworkInfo | undefined => {
  if (info === undefined) return undefined;
  return {
    internalRange: info.internalRange,
    internalRangeRef: info.internalRangeRef,
    subnetwork: info.subnetwork,
    subnetworkRef: info.subnetworkRef,
    delinked: info.delinked,
  };
};

const toAttrs = (
  policy: networkconnectivity.ServiceConnectionPolicy,
  project: string,
  region: string,
) => {
  const name = policy.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const location = parsed.location || region;
  return {
    name,
    serviceConnectionPolicyId: parsed.id,
    project: parsed.project || project,
    location,
    network: policy.network,
    serviceClass: policy.serviceClass,
    pscConfig: toPscConfig(
      policy.pscConfig,
      parsed.project || project,
      location,
    ),
    infrastructure: policy.infrastructure,
    autoCreatedSubnetInfo: toAutoCreated(policy.autoCreatedSubnetInfo),
    description: policy.description,
    labels: userLabels(policy.labels),
    etag: policy.etag,
    createTime: policy.createTime,
    updateTime: policy.updateTime,
  };
};

const getByName = (name: string) =>
  networkconnectivity
    .getProjectsLocationsServiceConnectionPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const ServiceConnectionPolicyProvider = () =>
  Provider.succeed(ServiceConnectionPolicy, {
    stables: [
      "name",
      "serviceConnectionPolicyId",
      "project",
      "location",
      "network",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId =
        olds?.serviceConnectionPolicyId ?? output?.serviceConnectionPolicyId;
      const nextId = news.serviceConnectionPolicyId
        ? rfc1035(news.serviceConnectionPolicyId, "service-connection-policy")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousNetwork = lastSegment(
        canonicalizeLink(olds?.network ?? output?.network),
      );
      const nextNetwork = lastSegment(canonicalizeLink(news.network));
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousNetwork.length > 0 && previousNetwork !== nextNetwork)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceConnectionPolicyId = yield* toPhysicalId(
        id,
        olds?.serviceConnectionPolicyId,
        output?.serviceConnectionPolicyId,
        "service-connection-policy",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, serviceConnectionPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkconnectivity.listProjectsLocationsServiceConnectionPolicies.pages(
            {
              parent: parentOf(env.project, "-"),
              pageSize: 1000,
            },
          ),
          (page) => page.serviceConnectionPolicies,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceConnectionPolicyId = yield* toPhysicalId(
        id,
        news.serviceConnectionPolicyId,
        output?.serviceConnectionPolicyId,
        "service-connection-policy",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(
        env.project,
        location,
        serviceConnectionPolicyId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const network = toNetworkResource(env.project, news.network);
      const pscConfig = toPscConfig(news.pscConfig, env.project, location);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkconnectivity
          .createProjectsLocationsServiceConnectionPolicies({
            parent: parentOf(env.project, location),
            serviceConnectionPolicyId,
            subnetworkMode: news.subnetworkMode,
            "autoSubnetworkConfig.ipStack": news.autoSubnetworkConfig?.ipStack,
            "autoSubnetworkConfig.prefixLength":
              news.autoSubnetworkConfig?.prefixLength,
            "autoSubnetworkConfig.allocRangeSpace": news.autoSubnetworkConfig
              ?.allocRangeSpace
              ? [...news.autoSubnetworkConfig.allocRangeSpace]
              : undefined,
            body: {
              network,
              serviceClass: news.serviceClass,
              pscConfig,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new NetworkConnectivityNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const serviceClassChanged =
        (current.serviceClass ?? "") !== news.serviceClass;
      const observedPsc = toPscConfig(current.pscConfig, env.project, location);
      const pscChanged = !sameJson(
        {
          subnetworks: [...(observedPsc?.subnetworks ?? [])]
            .map((value) => lastSegment(canonicalizeLink(value)))
            .sort(),
          limit: observedPsc?.limit ?? "",
          producerInstanceLocation: observedPsc?.producerInstanceLocation ?? "",
          allowedGoogleProducersResourceHierarchyLevel: [
            ...(observedPsc?.allowedGoogleProducersResourceHierarchyLevel ??
              []),
          ].sort(),
        },
        {
          subnetworks: [...(pscConfig?.subnetworks ?? [])]
            .map((value) => lastSegment(canonicalizeLink(value)))
            .sort(),
          limit: pscConfig?.limit ?? "",
          producerInstanceLocation: pscConfig?.producerInstanceLocation ?? "",
          allowedGoogleProducersResourceHierarchyLevel: [
            ...(pscConfig?.allowedGoogleProducersResourceHierarchyLevel ?? []),
          ].sort(),
        },
      );
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["serviceClass", serviceClassChanged],
        ["pscConfig", pscChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkconnectivity.patchProjectsLocationsServiceConnectionPolicies(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
                serviceClass: news.serviceClass,
                pscConfig,
                etag: current.etag,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkconnectivity
        .deleteProjectsLocationsServiceConnectionPolicies({
          name: output.name,
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
