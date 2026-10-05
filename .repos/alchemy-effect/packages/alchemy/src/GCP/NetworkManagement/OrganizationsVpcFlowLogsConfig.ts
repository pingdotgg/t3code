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
  listOrganizations,
  normalizeLocation,
  organizationParent,
  organizationResourceName,
  parseName,
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
  resolveOrganization,
} from "./internal.ts";

const COLLECTION = "vpcFlowLogsConfigs";
const DEFAULT_STATE =
  "ENABLED" satisfies networkmanagement.VpcFlowLogsConfigStateEnum;
const DEFAULT_INTERVAL =
  "INTERVAL_5_SEC" satisfies networkmanagement.VpcFlowLogsConfigAggregationIntervalEnum;
const DEFAULT_METADATA =
  "INCLUDE_ALL_METADATA" satisfies networkmanagement.VpcFlowLogsConfigMetadataEnum;
const DEFAULT_CROSS_PROJECT =
  "CROSS_PROJECT_METADATA_ENABLED" satisfies networkmanagement.VpcFlowLogsConfigCrossProjectMetadataEnum;
const DEFAULT_SAMPLING = 1;

export type OrganizationsVpcFlowLogsConfigState =
  | networkmanagement.VpcFlowLogsConfigStateEnum
  | (string & {});
export type OrganizationsVpcFlowLogsConfigAggregationInterval =
  | networkmanagement.VpcFlowLogsConfigAggregationIntervalEnum
  | (string & {});
export type OrganizationsVpcFlowLogsConfigMetadata =
  | networkmanagement.VpcFlowLogsConfigMetadataEnum
  | (string & {});
export type OrganizationsVpcFlowLogsConfigCrossProjectMetadata =
  | networkmanagement.VpcFlowLogsConfigCrossProjectMetadataEnum
  | (string & {});

export type OrganizationsVpcFlowLogsConfigProps = {
  /**
   * Config id (the `{vpc_flow_logs_config}` segment of
   * `organizations/{organization}/locations/global/vpcFlowLogsConfigs/{vpc_flow_logs_config}`).
   * If omitted, a unique RFC1035 name is generated. Immutable — changing
   * it replaces the config.
   */
  vpcFlowLogsConfigId?: string;
  /**
   * Organization id or `organizations/{organization}`. If omitted,
   * Alchemy uses `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager parent. Immutable — changing it replaces the config.
   */
  organization?: string;
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
  state?: OrganizationsVpcFlowLogsConfigState;
  /**
   * Log aggregation interval.
   * @default "INTERVAL_5_SEC"
   */
  aggregationInterval?: OrganizationsVpcFlowLogsConfigAggregationInterval;
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
  metadata?: OrganizationsVpcFlowLogsConfigMetadata;
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
   * Whether to include cross-project annotations. Organization configs
   * only.
   * @default "CROSS_PROJECT_METADATA_ENABLED"
   */
  crossProjectMetadata?: OrganizationsVpcFlowLogsConfigCrossProjectMetadata;
  /**
   * Optional VPC network to log. Organization configs may omit every
   * target to apply across the organization. Changing the target
   * resource replaces the config.
   */
  network?: string;
  /**
   * Optional subnetwork to log. Changing the target resource replaces
   * the config.
   */
  subnet?: string;
  /**
   * Optional interconnect attachment to log. Changing the target
   * resource replaces the config.
   */
  interconnectAttachment?: string;
  /**
   * Optional VPN tunnel to log. Changing the target resource replaces
   * the config.
   */
  vpnTunnel?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type OrganizationsVpcFlowLogsConfig = Resource<
  "GCP.NetworkManagement.OrganizationsVpcFlowLogsConfig",
  OrganizationsVpcFlowLogsConfigProps,
  {
    /** Full resource name `organizations/{organization}/locations/global/vpcFlowLogsConfigs/{vpc_flow_logs_config}`. */
    name: string;
    /** Config id (last path segment). */
    vpcFlowLogsConfigId: string;
    /** Organization id. */
    organization: string;
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
    /** Cross-project annotation mode. */
    crossProjectMetadata: string | undefined;
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
 * An organization-level VPC Flow Logs configuration.
 *
 * Organization configs apply across the organization when no target
 * resource is set. Changing the id, organization, location, or target
 * replaces the config. Description, labels, state, sampling, metadata,
 * cross-project annotations, and the export filter update in place.
 *
 * ### Creating an Organization VpcFlowLogsConfig
 * **Example:** Organization-wide logs
 * ```typescript
 * const logs = yield* GCP.NetworkManagement.OrganizationsVpcFlowLogsConfig(
 *   "OrgLogs",
 *   {
 *     aggregationInterval: "INTERVAL_1_MIN",
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * **Example:** Named org config
 * ```typescript
 * const logs = yield* GCP.NetworkManagement.OrganizationsVpcFlowLogsConfig(
 *   "OrgLogs",
 *   {
 *     vpcFlowLogsConfigId: "org-vpc-logs",
 *     organization: "123456789",
 *     description: "org vpc flow logs",
 *     crossProjectMetadata: "CROSS_PROJECT_METADATA_ENABLED",
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkManagement
 */
export const OrganizationsVpcFlowLogsConfig =
  Resource<OrganizationsVpcFlowLogsConfig>(
    "GCP.NetworkManagement.OrganizationsVpcFlowLogsConfig",
  );

const resourceName = (
  organization: string,
  location: string,
  vpcFlowLogsConfigId: string,
) =>
  organizationResourceName(
    organization,
    location,
    COLLECTION,
    vpcFlowLogsConfigId,
  );

const stateOf = (value: string | undefined) =>
  (value ?? DEFAULT_STATE).toUpperCase();

const intervalOf = (value: string | undefined) =>
  (value ?? DEFAULT_INTERVAL).toUpperCase();

const metadataOf = (value: string | undefined) =>
  (value ?? DEFAULT_METADATA).toUpperCase();

const crossProjectOf = (value: string | undefined) =>
  (value ?? DEFAULT_CROSS_PROJECT).toUpperCase();

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

const toAttrs = (config: networkmanagement.VpcFlowLogsConfig) => {
  const name = config.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    vpcFlowLogsConfigId: parsed.id,
    organization: parsed.organization,
    location: parsed.location || DEFAULT_GLOBAL,
    description: config.description,
    state: config.state,
    aggregationInterval: config.aggregationInterval,
    flowSampling: config.flowSampling,
    metadata: config.metadata,
    metadataFields: config.metadataFields ?? [],
    filterExpr: config.filterExpr,
    crossProjectMetadata: config.crossProjectMetadata,
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
    .getOrganizationsLocationsVpcFlowLogsConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (organization: string) =>
  collectPages(
    networkmanagement.listOrganizationsLocationsVpcFlowLogsConfigs.pages({
      parent: organizationParent(organization, DEFAULT_GLOBAL),
      pageSize: 1000,
    }),
    (page) => page.vpcFlowLogsConfigs,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelKeys(item.labels)).map(toAttrs),
    ),
  );

export const OrganizationsVpcFlowLogsConfigProvider = () =>
  Provider.succeed(OrganizationsVpcFlowLogsConfig, {
    stables: [
      "name",
      "vpcFlowLogsConfigId",
      "organization",
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
      const previousOrg = olds?.organization ?? output?.organization;
      const nextOrg = news.organization ?? previousOrg;
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
        (previousOrg !== undefined &&
          nextOrg !== undefined &&
          nextOrg !== previousOrg) ||
        previousLocation !== nextLocation ||
        previousTarget !== nextTarget
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const vpcFlowLogsConfigId = yield* toPhysicalId(
        id,
        olds?.vpcFlowLogsConfigId,
        output?.vpcFlowLogsConfigId,
        "vpc-flow-logs",
      );
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      ).pipe(
        Effect.catchTag("GCP.NetworkManagement.OrganizationRequired", () =>
          Effect.succeed(output?.organization ?? ""),
        ),
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        (organization.length > 0
          ? resourceName(organization, location, vpcFlowLogsConfigId)
          : "");
      if (name.length === 0) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const orgs = yield* listOrganizations(env.project);
        const listed: OrganizationsVpcFlowLogsConfig["Attributes"][] = [];
        for (const organization of orgs) {
          listed.push(...(yield* listOwned(organization)));
        }
        return listed;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const vpcFlowLogsConfigId = yield* toPhysicalId(
        id,
        news.vpcFlowLogsConfigId,
        output?.vpcFlowLogsConfigId,
        "vpc-flow-logs",
      );
      const organization = yield* resolveOrganization(
        news.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(organization, location, vpcFlowLogsConfigId);
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
      const crossProjectMetadata = crossProjectOf(news.crossProjectMetadata);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkmanagement
          .createOrganizationsLocationsVpcFlowLogsConfigs({
            parent: organizationParent(organization, location),
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
              crossProjectMetadata,
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
      const crossProjectChanged =
        (current.crossProjectMetadata ?? DEFAULT_CROSS_PROJECT) !==
        crossProjectMetadata;

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["state", stateChanged],
        ["aggregationInterval", intervalChanged],
        ["flowSampling", samplingChanged],
        ["metadata", metadataChanged],
        ["metadataFields", metadataFieldsChanged],
        ["filterExpr", filterChanged],
        ["crossProjectMetadata", crossProjectChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkmanagement.patchOrganizationsLocationsVpcFlowLogsConfigs(
            {
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
                crossProjectMetadata,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkmanagement
        .deleteOrganizationsLocationsVpcFlowLogsConfigs({ name: output.name })
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
