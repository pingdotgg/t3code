import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  alphanumericId,
  expandParent,
  hasAlchemyLabelMap,
  lastSegment,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const DEFAULT_DEPLOYMENT_TYPE = "DATABASE_ORACLE";
const DEFAULT_ADMIN_USERNAME = "oggadmin";

export type GoldengateOggData = {
  /**
   * GoldenGate console username. Required on create.
   */
  adminUsername: string;
  /**
   * Name of the GoldenGate service deployment (1–32 alphanumeric
   * characters, starting with a letter). Distinct from the GCP resource
   * id.
   */
  deployment: string;
  /**
   * Console password in plain text. Create-only; omitted from attributes.
   */
  adminPassword?: string;
  /**
   * Secret Manager version holding the console password
   * (`projects/{project}/secrets/{secret}/versions/{version}`).
   */
  adminPasswordSecretVersion?: string;
  /**
   * Oracle GoldenGate version. If omitted, the service picks a default.
   */
  oggVersion?: string;
};

export type GoldengateMaintenanceWindow = {
  /** UTC start hour for the maintenance window. */
  startHour?: number;
  /** Day of week (`MONDAY` … `SUNDAY`). */
  day?: oracle.GoldengateMaintenanceWindowDayEnum | (string & {});
};

export type GoldengateMaintenanceConfig = {
  /** Auto-upgrade period for bundle releases, in days. */
  bundleReleaseUpgradePeriodDays?: number;
  /** Auto-upgrade period for major releases, in days. */
  majorReleaseUpgradePeriodDays?: number;
  /** Auto-upgrade period for security patches, in days. */
  securityPatchUpgradePeriodDays?: number;
  /** Enable auto-upgrade for interim releases. */
  isInterimReleaseAutoUpgradeEnabled?: boolean;
  /** Auto-upgrade period for interim releases, in days. */
  interimReleaseUpgradePeriodDays?: number;
};

export type GoldengateDeploymentProps = {
  /**
   * Deployment id (the `{goldengate_deployment}` segment of
   * `projects/{project}/locations/{location}/goldengateDeployments/{goldengate_deployment}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the deployment.
   */
  goldengateDeploymentId?: string;
  /**
   * Region (`us-central1`, `us-east4`, …). Immutable — changing it
   * replaces the deployment.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name. Defaults to the generated resource id.
   */
  displayName?: string;
  /**
   * Parent ODB Network. Full name or id. Immutable — changing it
   * replaces the deployment.
   */
  odbNetwork?: string;
  /**
   * ODB Subnet used for IP allocation. Full name
   * `projects/{project}/locations/{location}/odbNetworks/{odb_network}/odbSubnets/{odb_subnet}`
   * or a bare subnet id (requires `odbNetwork`). Immutable — changing
   * it replaces the deployment.
   */
  odbSubnet: string;
  /**
   * GCP Oracle zone (e.g. `us-east4-b-r2`). Immutable — changing it
   * replaces the deployment.
   */
  gcpOracleZone?: string;
  /**
   * Oracle GoldenGate deployment type (`DATABASE_ORACLE`, `BIGDATA`,
   * `DATABASE_POSTGRESQL`, …). Immutable — changing it replaces the
   * deployment.
   * @default "DATABASE_ORACLE"
   */
  deploymentType?: string;
  /**
   * GoldenGate console and service identity. `deployment` is immutable.
   */
  oggData: GoldengateOggData;
  /**
   * Human-readable description stored on the Oracle properties.
   */
  description?: string;
  /**
   * Minimum OCPU count.
   */
  cpuCoreCount?: number;
  /**
   * Oracle license model (`LICENSE_INCLUDED`, `BRING_YOUR_OWN_LICENSE`).
   */
  licenseModel?:
    | oracle.GoldengateDeploymentPropertiesLicenseModelEnum
    | (string & {});
  /**
   * GoldenGate environment type (from `ListGoldengateDeploymentEnvironments`).
   */
  environmentType?: string;
  /**
   * Enable CPU auto-scaling.
   */
  isAutoScalingEnabled?: boolean;
  /**
   * Preferred weekly maintenance window.
   */
  maintenanceWindow?: GoldengateMaintenanceWindow;
  /**
   * Auto-upgrade periods for GoldenGate releases.
   */
  maintenanceConfig?: GoldengateMaintenanceConfig;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type GoldengateDeployment = Resource<
  "GCP.OracleDatabase.GoldengateDeployment",
  GoldengateDeploymentProps,
  {
    /** Full resource name. */
    name: string;
    /** Deployment id (last path segment). */
    goldengateDeploymentId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Parent ODB Network resource name. */
    odbNetwork: string | undefined;
    /** ODB Subnet resource name. */
    odbSubnet: string | undefined;
    /** GCP Oracle zone. */
    gcpOracleZone: string | undefined;
    /** GoldenGate deployment type. */
    deploymentType: string | undefined;
    /** GoldenGate service deployment name. */
    oggDeployment: string | undefined;
    /** GoldenGate console username. */
    adminUsername: string | undefined;
    /** GoldenGate version. */
    oggVersion: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Minimum OCPU count. */
    cpuCoreCount: number | undefined;
    /** License model. */
    licenseModel: string | undefined;
    /** Environment type. */
    environmentType: string | undefined;
    /** Whether CPU auto-scaling is enabled. */
    isAutoScalingEnabled: boolean | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Lifecycle state. */
    lifecycleState: string | undefined;
    /** Lifecycle details. */
    lifecycleDetails: string | undefined;
    /** GoldenGate FQDN. */
    fqdn: string | undefined;
    /** Deployment URL. */
    deploymentUrl: string | undefined;
    /** Private IP address. */
    privateIpAddress: string | undefined;
    /** Public IP address. */
    publicIpAddress: string | undefined;
    /** OCI console URL. */
    ociUrl: string | undefined;
    /** Marketplace entitlement id. */
    entitlementId: string | undefined;
    /** Oracle Cloud identifier. */
    ocid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle Database@Google Cloud GoldenGate deployment.
 *
 * Changing `goldengateDeploymentId`, `location`, `odbNetwork`,
 * `odbSubnet`, `gcpOracleZone`, `deploymentType`, or
 * `oggData.deployment` replaces the deployment. Labels and most
 * properties are set at create; the API has no update. Requires an
 * Oracle Database@Google Cloud entitlement and a client ODB Subnet.
 *
 * ### Creating a GoldenGate Deployment
 * **Example:** Oracle GoldenGate on an ODB Subnet
 * ```typescript
 * const gg = yield* GCP.OracleDatabase.GoldengateDeployment("Replicat", {
 *   odbSubnet: subnet.name,
 *   odbNetwork: net.name,
 *   displayName: "app-gg",
 *   deploymentType: "DATABASE_ORACLE",
 *   oggData: {
 *     adminUsername: "oggadmin",
 *     deployment: "oggdeploy",
 *     adminPassword: "change-me",
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const gg = yield* GCP.OracleDatabase.GoldengateDeployment("Replicat", {
 *   goldengateDeploymentId: "app-gg",
 *   odbSubnet: subnet.name,
 *   deploymentType: "DATABASE_ORACLE",
 *   oggData: {
 *     adminUsername: "oggadmin",
 *     deployment: "oggdeploy",
 *     adminPasswordSecretVersion: secret.latestVersionName,
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const GoldengateDeployment = Resource<GoldengateDeployment>(
  "GCP.OracleDatabase.GoldengateDeployment",
);

const resourceName = (
  project: string,
  location: string,
  goldengateDeploymentId: string,
) =>
  `projects/${project}/locations/${location}/goldengateDeployments/${goldengateDeploymentId}`;

const subnetOf = (
  odbSubnet: string,
  odbNetwork: string | undefined,
  project: string,
  location: string,
) => {
  if (odbSubnet.includes("/")) return odbSubnet.replace(/\/+$/, "");
  const network = odbNetwork
    ? expandParent(odbNetwork, project, location, "odbNetworks")
    : `projects/${project}/locations/${location}/odbNetworks`;
  return `${network}/odbSubnets/${odbSubnet}`;
};

const networkOf = (
  odbNetwork: string | undefined,
  project: string,
  location: string,
) =>
  odbNetwork === undefined || odbNetwork.length === 0
    ? undefined
    : expandParent(odbNetwork, project, location, "odbNetworks");

const desiredType = (type: string | undefined) =>
  type ?? DEFAULT_DEPLOYMENT_TYPE;

const toAttrs = (deployment: oracle.GoldengateDeployment, project: string) => {
  const name = deployment.name ?? "";
  const parsed = parseName(name, "goldengateDeployments");
  const properties = deployment.properties;
  return {
    name,
    goldengateDeploymentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: deployment.displayName,
    odbNetwork: deployment.odbNetwork,
    odbSubnet: deployment.odbSubnet,
    gcpOracleZone: deployment.gcpOracleZone,
    deploymentType: properties?.deploymentType,
    oggDeployment: properties?.oggData?.deployment,
    adminUsername: properties?.oggData?.adminUsername,
    oggVersion: properties?.oggData?.oggVersion,
    description: properties?.description,
    cpuCoreCount: properties?.cpuCoreCount,
    licenseModel: properties?.licenseModel,
    environmentType: properties?.environmentType,
    isAutoScalingEnabled: properties?.isAutoScalingEnabled,
    labels: userLabels(deployment.labels),
    lifecycleState: properties?.lifecycleState,
    lifecycleDetails: properties?.lifecycleDetails,
    fqdn: properties?.fqdn,
    deploymentUrl: properties?.deploymentUrl,
    privateIpAddress: properties?.privateIpAddress,
    publicIpAddress: properties?.publicIpAddress,
    ociUrl: deployment.ociUrl,
    entitlementId: deployment.entitlementId,
    ocid: properties?.ocid,
    createTime: deployment.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : oracle
        .getProjectsLocationsGoldengateDeployments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    oracle.listProjectsLocationsGoldengateDeployments
      .pages({ parent, pageSize: 1000 })
      .pipe(
        Stream.flatMap((page) =>
          Stream.fromIterable(page.goldengateDeployments ?? []),
        ),
        Stream.filter((item) => hasAlchemyLabelMap(item.labels)),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
        Effect.catchTag("NotFound", () => Effect.succeed([])),
      ),
  );

const toCreateBody = (
  news: GoldengateDeploymentProps,
  desiredLabels: Record<string, string>,
  displayName: string,
  odbNetwork: string | undefined,
  odbSubnet: string,
): oracle.GoldengateDeployment => ({
  displayName,
  odbNetwork,
  odbSubnet,
  gcpOracleZone: news.gcpOracleZone,
  labels: desiredLabels,
  properties: {
    deploymentType: desiredType(news.deploymentType),
    description: news.description,
    cpuCoreCount: news.cpuCoreCount,
    licenseModel: news.licenseModel,
    environmentType: news.environmentType,
    isAutoScalingEnabled: news.isAutoScalingEnabled,
    maintenanceWindow: news.maintenanceWindow,
    maintenanceConfig: news.maintenanceConfig,
    oggData: {
      adminUsername: news.oggData.adminUsername || DEFAULT_ADMIN_USERNAME,
      deployment: alphanumericId(news.oggData.deployment),
      adminPassword: news.oggData.adminPassword,
      adminPasswordSecretVersion: news.oggData.adminPasswordSecretVersion,
      oggVersion: news.oggData.oggVersion,
    },
  },
});

export const GoldengateDeploymentProvider = () =>
  Provider.succeed(GoldengateDeployment, {
    stables: [
      "name",
      "goldengateDeploymentId",
      "project",
      "location",
      "odbNetwork",
      "odbSubnet",
      "gcpOracleZone",
      "deploymentType",
      "oggDeployment",
      "entitlementId",
      "ocid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousType = desiredType(
        olds?.deploymentType ?? output?.deploymentType,
      );
      const nextType = desiredType(news.deploymentType ?? previousType);
      const previousOgg =
        olds?.oggData?.deployment ?? output?.oggDeployment ?? "";
      const nextOgg = news.oggData?.deployment ?? previousOgg;
      const previousZone = olds?.gcpOracleZone ?? output?.gcpOracleZone ?? "";
      const nextZone = news.gcpOracleZone ?? previousZone;
      const previousSubnet = lastSegment(
        olds?.odbSubnet ?? output?.odbSubnet ?? "",
      );
      const nextSubnet = lastSegment(news.odbSubnet ?? previousSubnet);
      return replaceOnIdentity({
        previousId:
          olds?.goldengateDeploymentId ?? output?.goldengateDeploymentId,
        nextId:
          news.goldengateDeploymentId ??
          olds?.goldengateDeploymentId ??
          output?.goldengateDeploymentId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        previousParent: olds?.odbNetwork ?? output?.odbNetwork,
        nextParent: news.odbNetwork ?? olds?.odbNetwork ?? output?.odbNetwork,
        extra:
          previousType !== nextType ||
          previousOgg !== nextOgg ||
          previousZone !== nextZone ||
          previousSubnet !== nextSubnet,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const goldengateDeploymentId = yield* toPhysicalId(
        id,
        olds?.goldengateDeploymentId,
        output?.goldengateDeploymentId,
        "goldengate",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, goldengateDeploymentId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const goldengateDeploymentId = yield* toPhysicalId(
        id,
        news.goldengateDeploymentId,
        output?.goldengateDeploymentId,
        "goldengate",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, goldengateDeploymentId);
      const odbNetwork = networkOf(news.odbNetwork, env.project, location);
      const odbSubnet = subnetOf(
        news.odbSubnet,
        news.odbNetwork ?? odbNetwork,
        env.project,
        location,
      );
      const displayName = news.displayName ?? goldengateDeploymentId;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsGoldengateDeployments({
            parent: parentOf(env.project, location),
            goldengateDeploymentId,
            body: toCreateBody(
              news,
              desiredLabels,
              displayName,
              odbNetwork,
              odbSubnet,
            ),
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

      const ready = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (item) => item.properties?.lifecycleState,
        (item) => item.properties?.lifecycleDetails,
      );

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* oracle
        .deleteProjectsLocationsGoldengateDeployments({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
