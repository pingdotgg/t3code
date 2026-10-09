import * as networkmanagement from "@distilled.cloud/gcp/networkmanagement_v1";
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
  DEFAULT_GLOBAL,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName as qualifiedName,
  rfc1035,
  sameStringList,
  toNetworkResource,
  toPhysicalId,
  toRegionalComputeResource,
  toSubnetworkResource,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "vpcFlowLogsConfigs";
const DEFAULT_STATE =
  "ENABLED" satisfies networkmanagement.VpcFlowLogsConfigStateEnum;
const DEFAULT_INTERVAL =
  "INTERVAL_5_SEC" satisfies networkmanagement.VpcFlowLogsConfigAggregationIntervalEnum;
const DEFAULT_METADATA =
  "INCLUDE_ALL_METADATA" satisfies networkmanagement.VpcFlowLogsConfigMetadataEnum;
const DEFAULT_SAMPLING = 1;

export type VpcFlowLogsConfigState =
  | networkmanagement.VpcFlowLogsConfigStateEnum
  | (string & {});
export type VpcFlowLogsConfigAggregationInterval =
  | networkmanagement.VpcFlowLogsConfigAggregationIntervalEnum
  | (string & {});
export type VpcFlowLogsConfigMetadata =
  | networkmanagement.VpcFlowLogsConfigMetadataEnum
  | (string & {});

export type VpcFlowLogsConfigProps = {
  /**
   * Config id (the `{vpc_flow_logs_config}` segment of
   * `projects/{project}/locations/global/vpcFlowLogsConfigs/{vpc_flow_logs_config}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the config.
   */
  vpcFlowLogsConfigId?: string;
  /**
   * Location. Must be `global`. Immutable — changing it replaces the
   * config.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable description (max 512 characters).
   */
  description?: string;
  /**
   * Whether log generation is enabled. Create requires `ENABLED`; a
   * subsequent update may set `DISABLED` to pause generation.
   * @default "ENABLED"
   */
  state?: VpcFlowLogsConfigState;
  /**
   * Log aggregation interval.
   * @default "INTERVAL_5_SEC"
   */
  aggregationInterval?: VpcFlowLogsConfigAggregationInterval;
  /**
   * Sampling rate in (0, 1]. Use `state` to disable logs rather than
   * setting this to 0.
   * @default 1
   */
  flowSampling?: number;
  /**
   * Which metadata fields to include in reported logs.
   * @default "INCLUDE_ALL_METADATA"
   */
  metadata?: VpcFlowLogsConfigMetadata;
  /**
   * Custom metadata fields. Only valid when `metadata` is
   * `CUSTOM_METADATA`.
   */
  metadataFields?: string[];
  /**
   * CEL export filter selecting which VPC Flow Logs are recorded.
   */
  filterExpr?: string;
  /**
   * VPC network to log. Format
   * `projects/{project}/global/networks/{name}` or a Compute self-link.
   * Mutually exclusive with `subnet`, `interconnectAttachment`, and
   * `vpnTunnel`. Changing the target resource replaces the config.
   */
  network?: string;
  /**
   * Subnetwork to log. Format
   * `projects/{project}/regions/{region}/subnetworks/{name}` or a Compute
   * self-link. Mutually exclusive with the other target fields. Changing
   * the target resource replaces the config.
   */
  subnet?: string;
  /**
   * Interconnect attachment to log. Format
   * `projects/{project}/regions/{region}/interconnectAttachments/{name}`.
   * Mutually exclusive with the other target fields. Changing the target
   * resource replaces the config.
   */
  interconnectAttachment?: string;
  /**
   * VPN tunnel to log. Format
   * `projects/{project}/regions/{region}/vpnTunnels/{name}`. Mutually
   * exclusive with the other target fields. Changing the target resource
   * replaces the config.
   */
  vpnTunnel?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type VpcFlowLogsConfig = Resource<
  "GCP.NetworkManagement.VpcFlowLogsConfig",
  VpcFlowLogsConfigProps,
  {
    /** Full resource name `projects/{project}/locations/global/vpcFlowLogsConfigs/{vpc_flow_logs_config}`. */
    name: string;
    /** Config id (last path segment). */
    vpcFlowLogsConfigId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`). */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** Whether log generation is enabled. */
    state: string | undefined;
    /** Aggregation interval. */
    aggregationInterval: string | undefined;
    /** Sampling rate. */
    flowSampling: number | undefined;
    /** Metadata inclusion mode. */
    metadata: string | undefined;
    /** Custom metadata fields. */
    metadataFields: string[];
    /** CEL export filter. */
    filterExpr: string | undefined;
    /** Diagnostic state of the configured target resource. */
    targetResourceState: string | undefined;
    /** Target VPC network, if set. */
    network: string | undefined;
    /** Target subnetwork, if set. */
    subnet: string | undefined;
    /** Target interconnect attachment, if set. */
    interconnectAttachment: string | undefined;
    /** Target VPN tunnel, if set. */
    vpnTunnel: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A project-level VPC Flow Logs configuration.
 *
 * Project configs require exactly one target (`network`, `subnet`,
 * `interconnectAttachment`, or `vpnTunnel`). Changing the id, location,
 * or target resource replaces the config. Description, labels, state,
 * sampling, metadata, and the export filter update in place. Creating
 * with `state=DISABLED` is rejected by the API, so Alchemy creates
 * `ENABLED` and then patches.
 *
 * ### Creating a VpcFlowLogsConfig
 * **Example:** Log an entire VPC
 * ```typescript
 * const network = yield* GCP.Compute.Network("AppVpc", {
 *   autoCreateSubnetworks: false,
 * });
 * const logs = yield* GCP.NetworkManagement.VpcFlowLogsConfig("VpcLogs", {
 *   network: network.selfLink ?? network.networkName,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Named config with sampling
 * ```typescript
 * const logs = yield* GCP.NetworkManagement.VpcFlowLogsConfig("VpcLogs", {
 *   vpcFlowLogsConfigId: "app-vpc-logs",
 *   network: "projects/my-project/global/networks/app-vpc",
 *   aggregationInterval: "INTERVAL_1_MIN",
 *   flowSampling: 0.5,
 *   description: "app vpc flow logs",
 * });
 * ```
 *
 * @resource
 * @category NetworkManagement
 */
export const VpcFlowLogsConfig = Resource<VpcFlowLogsConfig>(
  "GCP.NetworkManagement.VpcFlowLogsConfig",
);

const resourceName = (
  project: string,
  location: string,
  vpcFlowLogsConfigId: string,
) => qualifiedName(project, location, COLLECTION, vpcFlowLogsConfigId);

const stateOf = (value: string | undefined) =>
  (value ?? DEFAULT_STATE).toUpperCase();

const intervalOf = (value: string | undefined) =>
  (value ?? DEFAULT_INTERVAL).toUpperCase();

const metadataOf = (value: string | undefined) =>
  (value ?? DEFAULT_METADATA).toUpperCase();

const samplingOf = (value: number | undefined) => value ?? DEFAULT_SAMPLING;

const targetKey = (props: {
  network?: string;
  subnet?: string;
  interconnectAttachment?: string;
  vpnTunnel?: string;
}) =>
  JSON.stringify({
    network: lastSegmentOf(props.network),
    subnet: lastSegmentOf(props.subnet),
    interconnectAttachment: lastSegmentOf(props.interconnectAttachment),
    vpnTunnel: lastSegmentOf(props.vpnTunnel),
  });

const lastSegmentOf = (value: string | undefined) =>
  (value ?? "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\/+$/, "")
    .split("/")
    .pop()
    ?.toLowerCase() ?? "";

const toTarget = (
  project: string,
  region: string,
  news: {
    network?: string;
    subnet?: string;
    interconnectAttachment?: string;
    vpnTunnel?: string;
  },
) => ({
  network:
    news.network !== undefined
      ? toNetworkResource(project, news.network)
      : undefined,
  subnet:
    news.subnet !== undefined
      ? toSubnetworkResource(project, region, news.subnet)
      : undefined,
  interconnectAttachment:
    news.interconnectAttachment !== undefined
      ? toRegionalComputeResource(
          project,
          region,
          "interconnectAttachments",
          news.interconnectAttachment,
        )
      : undefined,
  vpnTunnel:
    news.vpnTunnel !== undefined
      ? toRegionalComputeResource(project, region, "vpnTunnels", news.vpnTunnel)
      : undefined,
});

const toAttrs = (
  config: networkmanagement.VpcFlowLogsConfig,
  project: string,
) => {
  const name = config.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    vpcFlowLogsConfigId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    description: config.description,
    state: config.state,
    aggregationInterval: config.aggregationInterval,
    flowSampling: config.flowSampling,
    metadata: config.metadata,
    metadataFields: config.metadataFields ?? [],
    filterExpr: config.filterExpr,
    targetResourceState: config.targetResourceState,
    network: config.network,
    subnet: config.subnet,
    interconnectAttachment: config.interconnectAttachment,
    vpnTunnel: config.vpnTunnel,
    labels: userLabels(config.labels),
    createTime: config.createTime,
    updateTime: config.updateTime,
  };
};

const getByName = (name: string) =>
  networkmanagement
    .getProjectsLocationsVpcFlowLogsConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const VpcFlowLogsConfigProvider = () =>
  Provider.succeed(VpcFlowLogsConfig, {
    stables: [
      "name",
      "vpcFlowLogsConfigId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.vpcFlowLogsConfigId ?? output?.vpcFlowLogsConfigId;
      const nextId = news.vpcFlowLogsConfigId
        ? rfc1035(news.vpcFlowLogsConfigId, "vpc-flow-logs")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const previousTarget = targetKey({
        network: olds?.network ?? output?.network,
        subnet: olds?.subnet ?? output?.subnet,
        interconnectAttachment:
          olds?.interconnectAttachment ?? output?.interconnectAttachment,
        vpnTunnel: olds?.vpnTunnel ?? output?.vpnTunnel,
      });
      const nextTarget = targetKey({
        network: news.network,
        subnet: news.subnet,
        interconnectAttachment: news.interconnectAttachment,
        vpnTunnel: news.vpnTunnel,
      });
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        previousTarget !== nextTarget
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const vpcFlowLogsConfigId = yield* toPhysicalId(
        id,
        olds?.vpcFlowLogsConfigId,
        output?.vpcFlowLogsConfigId,
        "vpc-flow-logs",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, vpcFlowLogsConfigId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkmanagement.listProjectsLocationsVpcFlowLogsConfigs.pages({
            parent: parentOf(env.project, DEFAULT_GLOBAL),
            pageSize: 1000,
          }),
          (page) => page.vpcFlowLogsConfigs,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const vpcFlowLogsConfigId = yield* toPhysicalId(
        id,
        news.vpcFlowLogsConfigId,
        output?.vpcFlowLogsConfigId,
        "vpc-flow-logs",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, vpcFlowLogsConfigId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const target = toTarget(env.project, env.region, news);
      const state = stateOf(news.state);
      const createState = state === "DISABLED" ? DEFAULT_STATE : state;
      const aggregationInterval = intervalOf(news.aggregationInterval);
      const flowSampling = samplingOf(news.flowSampling);
      const metadata = metadataOf(news.metadata);
      const metadataFields = news.metadataFields ?? [];
      const filterExpr = news.filterExpr;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkmanagement
          .createProjectsLocationsVpcFlowLogsConfigs({
            parent: parentOf(env.project, location),
            vpcFlowLogsConfigId,
            body: {
              description: news.description,
              labels: desiredLabels,
              state: createState,
              aggregationInterval,
              flowSampling,
              metadata,
              metadataFields:
                metadataFields.length > 0 ? metadataFields : undefined,
              filterExpr,
              ...target,
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

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const stateChanged = (current.state ?? DEFAULT_STATE) !== state;
      const intervalChanged =
        (current.aggregationInterval ?? DEFAULT_INTERVAL) !==
        aggregationInterval;
      const samplingChanged =
        (current.flowSampling ?? DEFAULT_SAMPLING) !== flowSampling;
      const metadataChanged =
        (current.metadata ?? DEFAULT_METADATA) !== metadata;
      const metadataFieldsChanged = !sameStringList(
        current.metadataFields,
        metadataFields,
      );
      const filterChanged = (current.filterExpr ?? "") !== (filterExpr ?? "");

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["state", stateChanged],
        ["aggregationInterval", intervalChanged],
        ["flowSampling", samplingChanged],
        ["metadata", metadataChanged],
        ["metadataFields", metadataFieldsChanged],
        ["filterExpr", filterChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkmanagement.patchProjectsLocationsVpcFlowLogsConfigs({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              state,
              aggregationInterval,
              flowSampling,
              metadata,
              metadataFields,
              filterExpr,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkmanagement
        .deleteProjectsLocationsVpcFlowLogsConfigs({ name: output.name })
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
