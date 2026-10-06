import * as metastore from "@distilled.cloud/gcp/metastore_v1";
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
  DEFAULT_HIVE_VERSION,
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type HiveMetastoreConfig = {
  /**
   * Hive metastore schema version. Immutable.
   * @default "3.1.2"
   */
  version?: string;
  /**
   * hive-site.xml overrides applied to the primary service.
   */
  configOverrides?: Record<string, string>;
  /**
   * Endpoint protocol (`THRIFT` or `GRPC`).
   */
  endpointProtocol?:
    | metastore.HiveMetastoreConfigEndpointProtocolEnum
    | (string & {});
  /**
   * Kerberos service-principal configuration.
   */
  kerberosConfig?: metastore.KerberosConfig;
  /**
   * Auxiliary Hive versions keyed by service name.
   */
  auxiliaryVersions?: metastore.AuxiliaryVersionConfigMap;
};

export type ServiceProps = {
  /**
   * Service id (the `{service}` segment of
   * `projects/{project}/locations/{location}/services/{service}`). If
   * omitted, a unique RFC1035 name is generated. Must be 2-63 characters,
   * start with a letter, and end with a letter or number. Immutable —
   * changing it replaces the service.
   */
  serviceId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * service. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Hive metastore software configuration. `version` is immutable.
   */
  hiveMetastoreConfig?: HiveMetastoreConfig;
  /**
   * Service tier (`DEVELOPER` or `ENTERPRISE`).
   * @default "DEVELOPER"
   */
  tier?: metastore.ServiceTierEnum | (string & {});
  /**
   * TCP port for the Hive endpoint.
   * @default 9083
   */
  port?: number;
  /**
   * VPC network
   * (`projects/{project}/global/networks/{network}`). Immutable.
   */
  network?: string;
  /**
   * Backend database type. Immutable.
   */
  databaseType?: metastore.ServiceDatabaseTypeEnum | (string & {});
  /**
   * When true, delete is rejected until protection is cleared.
   * @default false
   */
  deletionProtection?: boolean;
  /**
   * Release channel. Immutable.
   */
  releaseChannel?: metastore.ServiceReleaseChannelEnum | (string & {});
  /**
   * Customer-managed encryption. Immutable.
   */
  encryptionConfig?: metastore.EncryptionConfig;
  /**
   * Consumer-side network configuration. Immutable.
   */
  networkConfig?: metastore.NetworkConfig;
  /**
   * Scaling configuration.
   */
  scalingConfig?: metastore.ScalingConfig;
  /**
   * Telemetry / log format. Defaults to JSON.
   */
  telemetryConfig?: metastore.TelemetryConfig;
  /**
   * Scheduled backup configuration.
   */
  scheduledBackup?: metastore.ScheduledBackup;
  /**
   * External metadata integrations (Data Catalog).
   */
  metadataIntegration?: metastore.MetadataIntegration;
  /**
   * One-hour UTC maintenance window. Not used with SPANNER.
   */
  maintenanceWindow?: metastore.MaintenanceWindow;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Service = Resource<
  "GCP.Metastore.Service",
  ServiceProps,
  {
    /** Full resource name. */
    name: string;
    /** Service id (last path segment). */
    serviceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Hive metastore configuration. */
    hiveMetastoreConfig: HiveMetastoreConfig | undefined;
    /** Service tier. */
    tier: string | undefined;
    /** Hive endpoint port. */
    port: number | undefined;
    /** VPC network. */
    network: string | undefined;
    /** Backend database type. */
    databaseType: string | undefined;
    /** Whether delete is protected. */
    deletionProtection: boolean;
    /** Release channel. */
    releaseChannel: string | undefined;
    /** Customer-managed encryption, if any. */
    encryptionConfig: metastore.EncryptionConfig | undefined;
    /** Consumer network configuration. */
    networkConfig: metastore.NetworkConfig | undefined;
    /** Scaling configuration. */
    scalingConfig: metastore.ScalingConfig | undefined;
    /** Telemetry configuration. */
    telemetryConfig: metastore.TelemetryConfig | undefined;
    /** Scheduled backup configuration. */
    scheduledBackup: metastore.ScheduledBackup | undefined;
    /** External metadata integrations. */
    metadataIntegration: metastore.MetadataIntegration | undefined;
    /** Maintenance window. */
    maintenanceWindow: metastore.MaintenanceWindow | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Hive endpoint URI. */
    endpointUri: string | undefined;
    /** Artifact Cloud Storage URI. */
    artifactGcsUri: string | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Extra status text, if any. */
    stateMessage: string | undefined;
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
 * A Dataproc Metastore service — a managed Hive metastore.
 *
 * Changing `serviceId`, `location`, Hive `version`, `network`,
 * `databaseType`, `encryptionConfig`, `networkConfig`, or
 * `releaseChannel` replaces the service. Labels, port, tier, scaling,
 * telemetry, scheduled backups, metadata integration, maintenance
 * window, Hive overrides, and deletion protection update in place.
 *
 * ### Creating a Service
 * **Example:** Developer tier
 * ```typescript
 * const service = yield* GCP.Metastore.Service("Hive", {
 *   hiveMetastoreConfig: { version: "3.1.2" },
 *   tier: "DEVELOPER",
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const service = yield* GCP.Metastore.Service("Hive", {
 *   serviceId: "analytics-hive",
 *   hiveMetastoreConfig: { version: "3.1.2" },
 *   port: 9083,
 * });
 * ```
 *
 * ### Updating a Service
 * **Example:** Labels and port
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const service = yield* GCP.Metastore.Service("Hive", {
 *   hiveMetastoreConfig: { version: "3.1.2" },
 *   port: 9084,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Metastore
 */
export const Service = Resource<Service>("GCP.Metastore.Service");

const resourceName = (project: string, location: string, serviceId: string) =>
  `${locationParent(project, location)}/services/${serviceId}`;

const toHiveConfig = (
  config: metastore.HiveMetastoreConfig | undefined,
): HiveMetastoreConfig | undefined =>
  config === undefined
    ? undefined
    : {
        version: config.version,
        configOverrides: tagRecord(config.configOverrides),
        endpointProtocol: config.endpointProtocol,
        kerberosConfig: config.kerberosConfig,
        auxiliaryVersions: config.auxiliaryVersions,
      };

const desiredHiveConfig = (
  config: HiveMetastoreConfig | undefined,
): metastore.HiveMetastoreConfig => ({
  version: config?.version ?? DEFAULT_HIVE_VERSION,
  configOverrides: config?.configOverrides,
  endpointProtocol: config?.endpointProtocol,
  kerberosConfig: config?.kerberosConfig,
  auxiliaryVersions: config?.auxiliaryVersions,
});

const toAttrs = (item: metastore.Service, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "services", region);
  return {
    name,
    serviceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    hiveMetastoreConfig: toHiveConfig(item.hiveMetastoreConfig),
    tier: item.tier,
    port: item.port,
    network: item.network,
    databaseType: item.databaseType,
    deletionProtection: item.deletionProtection === true,
    releaseChannel: item.releaseChannel,
    encryptionConfig: item.encryptionConfig,
    networkConfig: item.networkConfig,
    scalingConfig: item.scalingConfig,
    telemetryConfig: item.telemetryConfig,
    scheduledBackup: item.scheduledBackup,
    metadataIntegration: item.metadataIntegration,
    maintenanceWindow: item.maintenanceWindow,
    labels: userLabels(item.labels),
    endpointUri: item.endpointUri,
    artifactGcsUri: item.artifactGcsUri,
    state: item.state,
    stateMessage: item.stateMessage,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : metastore
        .getProjectsLocationsServices({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      metastore.listProjectsLocationsServices.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.services,
      (item) => item.labels,
    ),
  );

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: [
      "name",
      "serviceId",
      "project",
      "location",
      "network",
      "databaseType",
      "releaseChannel",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousVersion =
        olds?.hiveMetastoreConfig?.version ??
        output?.hiveMetastoreConfig?.version;
      const nextVersion = news.hiveMetastoreConfig?.version ?? previousVersion;
      const previousNetwork = olds?.network ?? output?.network;
      const previousDatabase = olds?.databaseType ?? output?.databaseType;
      const previousChannel = olds?.releaseChannel ?? output?.releaseChannel;
      return replaceOnIdentity({
        previousId: olds?.serviceId ?? output?.serviceId,
        nextId: news.serviceId ?? olds?.serviceId ?? output?.serviceId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousVersion !== undefined &&
            nextVersion !== undefined &&
            nextVersion !== previousVersion) ||
          (previousNetwork !== undefined &&
            news.network !== undefined &&
            news.network !== previousNetwork) ||
          (previousDatabase !== undefined &&
            news.databaseType !== undefined &&
            news.databaseType !== previousDatabase) ||
          (previousChannel !== undefined &&
            news.releaseChannel !== undefined &&
            news.releaseChannel !== previousChannel) ||
          (olds?.encryptionConfig !== undefined &&
            news.encryptionConfig !== undefined &&
            fingerprint(news.encryptionConfig) !==
              fingerprint(olds.encryptionConfig)) ||
          (olds?.networkConfig !== undefined &&
            news.networkConfig !== undefined &&
            fingerprint(news.networkConfig) !==
              fingerprint(olds.networkConfig)),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toPhysicalId(
        id,
        olds?.serviceId,
        output?.serviceId,
        "service",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, serviceId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toPhysicalId(
        id,
        news.serviceId,
        output?.serviceId,
        "service",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, serviceId);
      const hive = desiredHiveConfig(news.hiveMetastoreConfig);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* metastore
          .createProjectsLocationsServices({
            parent: locationParent(env.project, location),
            serviceId,
            body: {
              hiveMetastoreConfig: hive,
              tier: news.tier,
              port: news.port,
              network: news.network,
              databaseType: news.databaseType,
              deletionProtection: news.deletionProtection,
              releaseChannel: news.releaseChannel,
              encryptionConfig: news.encryptionConfig,
              networkConfig: news.networkConfig,
              scalingConfig: news.scalingConfig,
              telemetryConfig: news.telemetryConfig,
              scheduledBackup: news.scheduledBackup,
              metadataIntegration: news.metadataIntegration,
              maintenanceWindow: news.maintenanceWindow,
              labels: desiredLabels,
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
        current = yield* waitUntilReady(
          getByName(name),
          name,
          (item) => item.state,
          (item) => item.stateMessage,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const hiveChanged =
        fingerprint({
          configOverrides: current.hiveMetastoreConfig?.configOverrides,
          endpointProtocol: current.hiveMetastoreConfig?.endpointProtocol,
          kerberosConfig: current.hiveMetastoreConfig?.kerberosConfig,
          auxiliaryVersions: current.hiveMetastoreConfig?.auxiliaryVersions,
        }) !==
        fingerprint({
          configOverrides: hive.configOverrides,
          endpointProtocol: hive.endpointProtocol,
          kerberosConfig: hive.kerberosConfig,
          auxiliaryVersions: hive.auxiliaryVersions,
        });
      const mask = fieldMask([
        labelsChanged && "labels",
        news.port !== undefined && news.port !== current.port && "port",
        news.tier !== undefined && !sameText(current.tier, news.tier) && "tier",
        news.deletionProtection !== undefined &&
          (current.deletionProtection === true) !==
            (news.deletionProtection === true) &&
          "deletionProtection",
        news.scalingConfig !== undefined &&
          fingerprint(current.scalingConfig) !==
            fingerprint(news.scalingConfig) &&
          "scalingConfig",
        news.telemetryConfig !== undefined &&
          fingerprint(current.telemetryConfig) !==
            fingerprint(news.telemetryConfig) &&
          "telemetryConfig",
        news.scheduledBackup !== undefined &&
          fingerprint(current.scheduledBackup) !==
            fingerprint(news.scheduledBackup) &&
          "scheduledBackup",
        news.metadataIntegration !== undefined &&
          fingerprint(current.metadataIntegration) !==
            fingerprint(news.metadataIntegration) &&
          "metadataIntegration",
        news.maintenanceWindow !== undefined &&
          fingerprint(current.maintenanceWindow) !==
            fingerprint(news.maintenanceWindow) &&
          "maintenanceWindow",
        hiveChanged && "hiveMetastoreConfig",
      ]);

      if (mask.length > 0) {
        const operation = yield* metastore.patchProjectsLocationsServices({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            labels: desiredLabels,
            port: news.port,
            tier: news.tier,
            deletionProtection: news.deletionProtection,
            scalingConfig: news.scalingConfig,
            telemetryConfig: news.telemetryConfig,
            scheduledBackup: news.scheduledBackup,
            metadataIntegration: news.metadataIntegration,
            maintenanceWindow: news.maintenanceWindow,
            hiveMetastoreConfig: hive,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
          (item) => item.state,
          (item) => item.stateMessage,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      if (existing.deletionProtection === true) {
        const unlocked = yield* metastore
          .patchProjectsLocationsServices({
            name: output.name,
            updateMask: "deletionProtection",
            body: { deletionProtection: false },
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (unlocked !== undefined) {
          // NOT_FOUND (5): already gone.
          yield* waitForOperation(unlocked).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 5 ? Effect.void : Effect.fail(error),
            ),
          );
        }
      }
      const operation = yield* metastore
        .deleteProjectsLocationsServices({ name: output.name })
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
