import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

// Composer rejects 64-character ids (even on GET) despite documenting
// "a letter followed by up to 63" characters.
const MAX_NAME_LENGTH = 63;

/**
 * Composer rejects `locations/-` (`Unexpected location: -`). Nuke walks
 * known Composer regions instead.
 */
const LIST_LOCATIONS = [
  "africa-south1",
  "asia-east1",
  "asia-east2",
  "asia-northeast1",
  "asia-northeast2",
  "asia-northeast3",
  "asia-south1",
  "asia-south2",
  "asia-southeast1",
  "asia-southeast2",
  "australia-southeast1",
  "australia-southeast2",
  "europe-central2",
  "europe-north1",
  "europe-southwest1",
  "europe-west1",
  "europe-west2",
  "europe-west3",
  "europe-west4",
  "europe-west6",
  "europe-west8",
  "europe-west9",
  "europe-west10",
  "europe-west12",
  "me-central1",
  "me-central2",
  "me-west1",
  "northamerica-northeast1",
  "northamerica-northeast2",
  "southamerica-east1",
  "southamerica-west1",
  "us-central1",
  "us-east1",
  "us-east4",
  "us-east5",
  "us-south1",
  "us-west1",
  "us-west2",
  "us-west3",
  "us-west4",
] as const;

export type EnvironmentConfig = composer.EnvironmentConfig;
export type SoftwareConfig = composer.SoftwareConfig;
export type NodeConfig = composer.NodeConfig;
export type WorkloadsConfig = composer.WorkloadsConfig;
export type PrivateEnvironmentConfig = composer.PrivateEnvironmentConfig;
export type StorageConfig = composer.StorageConfig;
export type MaintenanceWindow = composer.MaintenanceWindow;
export type WebServerNetworkAccessControl =
  composer.WebServerNetworkAccessControl;
export type MasterAuthorizedNetworksConfig =
  composer.MasterAuthorizedNetworksConfig;
export type RecoveryConfig = composer.RecoveryConfig;
export type DataRetentionConfig = composer.DataRetentionConfig;
export type DatabaseConfig = composer.DatabaseConfig;
export type WebServerConfig = composer.WebServerConfig;
export type EncryptionConfig = composer.EncryptionConfig;

export type EnvironmentSize =
  | composer.EnvironmentConfigEnvironmentSizeEnum
  | (string & {});
export type ResilienceMode =
  | composer.EnvironmentConfigResilienceModeEnum
  | (string & {});
export type EnvironmentState = composer.EnvironmentStateEnum | (string & {});

export type EnvironmentProps = {
  /**
   * Environment id (the `{environment}` segment of
   * `projects/{project}/locations/{location}/environments/{environment}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Must start with a lowercase letter, be 1-63 characters,
   * and match `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it
   * replaces the environment.
   */
  environmentId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the environment. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Configuration for software, nodes, workloads, size, networking, and
   * related settings. Node network/subnetwork, service account, encryption,
   * private-IP, python version, and storage bucket are immutable.
   *
   * New environments require an explicit `nodeConfig.serviceAccount` —
   * Composer rejects creates without one (`Composer environment service
   * account is required to be explicitly specified`). The account needs
   * `roles/composer.worker` (or broader) on the project. Changing it
   * replaces the environment.
   */
  config?: EnvironmentConfig;
  /**
   * Cloud Storage bucket used by the environment (`bucket` has no `gs://`
   * prefix). Immutable — changing it replaces the environment.
   */
  storageConfig?: StorageConfig;
};

export type Environment = Resource<
  "GCP.Composer.Environment",
  EnvironmentProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/environments/{environment}`. */
    name: string;
    /** Environment id (last path segment). */
    environmentId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** Server-generated UUID. */
    uuid: string | undefined;
    /** Server-reported state (`RUNNING`, `CREATING`, …). */
    state: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Configuration currently applied, including output-only URIs. */
    config: EnvironmentConfig | undefined;
    /** Storage configuration currently applied. */
    storageConfig: StorageConfig | undefined;
    /** Apache Airflow Web UI URI. */
    airflowUri: string | undefined;
    /** Airflow Web UI URI for workforce identity federation. */
    airflowByoidUri: string | undefined;
    /** GKE cluster that runs this environment. */
    gkeCluster: string | undefined;
    /** Cloud Storage prefix of the DAGs for this environment. */
    dagGcsPrefix: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Composer environment (Managed Apache Airflow).
 *
 * Changing `environmentId`, `location`, node network/subnetwork, node
 * service account, encryption, private-IP settings, python version, or the
 * storage bucket replaces the environment. Labels, PyPI packages, Airflow config overrides, env vars,
 * image version, workloads, and environment size update in place — one
 * update type per Composer patch, applied sequentially.
 *
 * Provisioning typically takes 20–45 minutes. Polls the LRO via
 * `getProjectsLocationsOperations` (Composer has no wait long-poll).
 *
 * New environments must name their service account explicitly in
 * `config.nodeConfig.serviceAccount`; Composer no longer falls back to the
 * default Compute Engine account. The account needs `roles/composer.worker`
 * (or broader) on the project. Changing it replaces the environment.
 *
 * ### Creating an Environment
 * **Example:** Generated name, Composer 3 small
 * ```typescript
 * const airflow = yield* GCP.Composer.Environment("Airflow", {
 *   config: {
 *     environmentSize: "ENVIRONMENT_SIZE_SMALL",
 *     nodeConfig: {
 *       serviceAccount: "composer-env@my-project.iam.gserviceaccount.com",
 *     },
 *     softwareConfig: { imageVersion: "composer-3-airflow-2" },
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id, labels, and PyPI packages
 * ```typescript
 * const airflow = yield* GCP.Composer.Environment("Airflow", {
 *   environmentId: "app-airflow",
 *   location: "us-central1",
 *   labels: { env: "prod" },
 *   config: {
 *     environmentSize: "ENVIRONMENT_SIZE_SMALL",
 *     nodeConfig: {
 *       serviceAccount: "composer-env@my-project.iam.gserviceaccount.com",
 *     },
 *     softwareConfig: {
 *       imageVersion: "composer-3-airflow-2",
 *       pypiPackages: { numpy: "==2.1.0" },
 *     },
 *   },
 * });
 * ```
 *
 * ### Updating software
 * **Example:** Override Airflow config and env vars
 * ```typescript
 * const airflow = yield* GCP.Composer.Environment("Airflow", {
 *   environmentId: "app-airflow",
 *   config: {
 *     softwareConfig: {
 *       airflowConfigOverrides: { "core-dags_are_paused_at_creation": "True" },
 *       envVariables: { EXAMPLE_VAR: "test" },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Composer
 */
export const Environment = Resource<Environment>("GCP.Composer.Environment");

export class EnvironmentNotResolved extends Data.TaggedError(
  "GCP.Composer.EnvironmentNotResolved",
)<{
  name: string;
}> {}

export class EnvironmentNotReady extends Data.TaggedError(
  "GCP.Composer.EnvironmentNotReady",
)<{
  name: string;
  state: string;
}> {}

export class EnvironmentFailed extends Data.TaggedError(
  "GCP.Composer.EnvironmentFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class EnvironmentStillExists extends Data.TaggedError(
  "GCP.Composer.EnvironmentStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `c${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "environment";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (
  project: string,
  location: string,
  environmentId: string,
) => `projects/${project}/locations/${location}/environments/${environmentId}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const environmentsAt = parts.lastIndexOf("environments");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    environmentId:
      environmentsAt >= 0 && parts[environmentsAt + 1]
        ? parts[environmentsAt + 1]!
        : lastSegment(name),
  };
};

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toId = (
  id: string,
  environmentId: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    return (
      environmentId ??
      existing ??
      rfc1035(
        yield* createPhysicalName({
          id,
          maxLength: MAX_NAME_LENGTH,
          lowercase: true,
        }),
      )
    );
  });

const comparable = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(comparable);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, comparable(item)]),
    );
  }
  return value;
};

const jsonKey = (value: unknown) => JSON.stringify(comparable(value) ?? null);

const mapOf = (
  map: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const mapKey = (map: Record<string, string | undefined> | null | undefined) =>
  jsonKey(mapOf(map));

const sizeOf = (size: string | undefined) => {
  const value = (size ?? "").toUpperCase();
  return value === "ENVIRONMENT_SIZE_UNSPECIFIED" ? "" : value;
};

const resilienceOf = (mode: string | undefined) => {
  const value = (mode ?? "").toUpperCase();
  return value === "RESILIENCE_MODE_UNSPECIFIED" ? "" : value;
};

const pluginsOf = (mode: string | undefined) => {
  const value = (mode ?? "").toUpperCase();
  return value === "WEB_SERVER_PLUGINS_MODE_UNSPECIFIED" ? "" : value;
};

const imageVersionMatches = (
  desired: string | undefined,
  observed: string | undefined,
) => {
  if (desired === undefined || desired.length === 0) return true;
  if (observed === undefined) return false;
  if (desired === observed) return true;
  if (!observed.startsWith(desired)) return false;
  const next = observed[desired.length];
  return next === undefined || next === "-" || next === ".";
};

const networkId = (value: string | undefined) =>
  value === undefined || value.length === 0 ? undefined : lastSegment(value);

const fieldChanged = (next: unknown, prev: unknown) =>
  next !== undefined && prev !== undefined && jsonKey(next) !== jsonKey(prev);

const networkChanged = (next: string | undefined, prev: string | undefined) =>
  next !== undefined &&
  prev !== undefined &&
  networkId(next) !== networkId(prev);

const listChanged = (
  next: ReadonlyArray<string> | undefined,
  prev: ReadonlyArray<string> | undefined,
) =>
  next !== undefined &&
  prev !== undefined &&
  jsonKey([...next].map((item) => item.toLowerCase()).sort()) !==
    jsonKey([...prev].map((item) => item.toLowerCase()).sort());

const immutableChanged = (
  news: EnvironmentProps,
  olds: Partial<EnvironmentProps> | undefined,
  output: Environment["Attributes"] | undefined,
) => {
  const prevConfig = olds?.config ?? output?.config;
  const nextConfig = news.config;
  const prevStorage = olds?.storageConfig ?? output?.storageConfig;
  const nextStorage = news.storageConfig;
  const prevNode = prevConfig?.nodeConfig;
  const nextNode = nextConfig?.nodeConfig;
  const prevPrivate = prevConfig?.privateEnvironmentConfig;
  const nextPrivate = nextConfig?.privateEnvironmentConfig;

  return (
    (nextConfig !== undefined &&
      prevConfig !== undefined &&
      (networkChanged(nextNode?.network, prevNode?.network) ||
        networkChanged(nextNode?.subnetwork, prevNode?.subnetwork) ||
        fieldChanged(nextNode?.machineType, prevNode?.machineType) ||
        fieldChanged(nextNode?.diskSizeGb, prevNode?.diskSizeGb) ||
        networkChanged(nextNode?.location, prevNode?.location) ||
        networkChanged(nextNode?.serviceAccount, prevNode?.serviceAccount) ||
        listChanged(nextNode?.oauthScopes, prevNode?.oauthScopes) ||
        listChanged(nextNode?.tags, prevNode?.tags) ||
        fieldChanged(
          nextNode?.ipAllocationPolicy,
          prevNode?.ipAllocationPolicy,
        ) ||
        fieldChanged(
          nextNode?.enableIpMasqAgent,
          prevNode?.enableIpMasqAgent,
        ) ||
        fieldChanged(
          nextNode?.composerInternalIpv4CidrBlock,
          prevNode?.composerInternalIpv4CidrBlock,
        ) ||
        networkChanged(
          nextNode?.composerNetworkAttachment,
          prevNode?.composerNetworkAttachment,
        ) ||
        fieldChanged(
          nextConfig.encryptionConfig?.kmsKeyName,
          prevConfig.encryptionConfig?.kmsKeyName,
        ) ||
        fieldChanged(
          nextConfig.softwareConfig?.pythonVersion,
          prevConfig.softwareConfig?.pythonVersion,
        ) ||
        fieldChanged(
          nextConfig.databaseConfig?.zone,
          prevConfig.databaseConfig?.zone,
        ) ||
        fieldChanged(
          nextPrivate?.enablePrivateEnvironment,
          prevPrivate?.enablePrivateEnvironment,
        ) ||
        fieldChanged(
          nextPrivate?.networkingType,
          prevPrivate?.networkingType,
        ) ||
        networkChanged(
          nextPrivate?.cloudComposerConnectionSubnetwork,
          prevPrivate?.cloudComposerConnectionSubnetwork,
        ) ||
        fieldChanged(
          nextPrivate?.cloudComposerNetworkIpv4CidrBlock,
          prevPrivate?.cloudComposerNetworkIpv4CidrBlock,
        ) ||
        fieldChanged(
          nextPrivate?.cloudSqlIpv4CidrBlock,
          prevPrivate?.cloudSqlIpv4CidrBlock,
        ) ||
        fieldChanged(
          nextPrivate?.webServerIpv4CidrBlock,
          prevPrivate?.webServerIpv4CidrBlock,
        ) ||
        fieldChanged(
          nextPrivate?.enablePrivatelyUsedPublicIps,
          prevPrivate?.enablePrivatelyUsedPublicIps,
        ) ||
        fieldChanged(
          nextPrivate?.privateClusterConfig,
          prevPrivate?.privateClusterConfig,
        ) ||
        fieldChanged(
          nextPrivate?.networkingConfig,
          prevPrivate?.networkingConfig,
        ) ||
        fieldChanged(
          nextPrivate?.enablePrivateBuildsOnly,
          prevPrivate?.enablePrivateBuildsOnly,
        ))) ||
    (nextStorage?.bucket !== undefined &&
      prevStorage?.bucket !== undefined &&
      nextStorage.bucket !== prevStorage.bucket)
  );
};

const toAttrs = (
  environment: composer.Environment,
  project: string,
  region: string,
) => {
  const name = environment.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    environmentId: parsed.environmentId,
    project: parsed.project || project,
    location: parsed.location,
    uuid: environment.uuid,
    state: environment.state,
    labels: userLabels(environment.labels),
    config: environment.config,
    storageConfig: environment.storageConfig,
    airflowUri: environment.config?.airflowUri,
    airflowByoidUri: environment.config?.airflowByoidUri,
    gkeCluster: environment.config?.gkeCluster,
    dagGcsPrefix: environment.config?.dagGcsPrefix,
    createTime: environment.createTime,
    updateTime: environment.updateTime,
  };
};

const isPlaceholder = (environment: composer.Environment) => {
  const name = environment.name ?? "";
  return name.endsWith("/environments/-") || name.endsWith("/environments/");
};

const getByName = (name: string) =>
  composer
    .getProjectsLocationsEnvironments({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

// Environment creates run 20-30 minutes, deletes 10-20.
const waitForOperation = (operation: composer.Operation) =>
  waitForGcpOperation(
    operation,
    (name) => composer.getProjectsLocationsOperations({ name }),
    { budget: "45 minutes", interval: "15 seconds" },
  );

const waitUntilRunning = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (environment): environment is composer.Environment =>
        environment !== undefined,
      () => new EnvironmentNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (environment) => environment.state !== "ERROR",
      (environment) =>
        new EnvironmentFailed({
          name,
          state: environment.state,
        }),
    ),
    Effect.filterOrFail(
      (environment) => environment.state === "RUNNING",
      (environment) =>
        new EnvironmentNotReady({
          name,
          state: environment.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Composer.EnvironmentNotResolved" ||
        error._tag === "GCP.Composer.EnvironmentNotReady",
      times: 240,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((environment) =>
      environment === undefined
        ? Effect.void
        : Effect.fail(new EnvironmentStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Composer.EnvironmentStillExists",
      times: 120,
      schedule: Schedule.spaced("15 seconds"),
    }),
  );

const listOwnedAt = (project: string, location: string) =>
  composer.listProjectsLocationsEnvironments
    .pages({
      parent: `projects/${project}/locations/${location}`,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.environments ?? [])),
      Stream.filter(
        (environment) =>
          !isPlaceholder(environment) &&
          Object.keys(environment.labels ?? {}).some((key) =>
            key.startsWith("alchemy-"),
          ),
      ),
      Stream.map((environment) => toAttrs(environment, project, location)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      // A location Composer does not serve has no environments.
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCreateConfig = (
  config: composer.EnvironmentConfig | undefined,
): composer.EnvironmentConfig | undefined => {
  if (config === undefined) return undefined;
  const {
    airflowByoidUri: _airflowByoidUri,
    airflowUri: _airflowUri,
    gkeCluster: _gkeCluster,
    dagGcsPrefix: _dagGcsPrefix,
    ...rest
  } = config;
  return rest;
};

type EnvironmentPatch = {
  mask: string;
  body: composer.Environment;
};

const desiredPatches = (
  news: EnvironmentProps,
  current: composer.Environment,
  desiredLabels: Record<string, string>,
  labelsChanged: boolean,
): EnvironmentPatch[] => {
  const patches: EnvironmentPatch[] = [];
  if (labelsChanged) {
    patches.push({ mask: "labels", body: { labels: desiredLabels } });
  }

  const nextSoftware = news.config?.softwareConfig;
  const currentSoftware = current.config?.softwareConfig;

  if (
    nextSoftware?.pypiPackages !== undefined &&
    mapKey(nextSoftware.pypiPackages) !== mapKey(currentSoftware?.pypiPackages)
  ) {
    patches.push({
      mask: "config.softwareConfig.pypiPackages",
      body: {
        config: { softwareConfig: { pypiPackages: nextSoftware.pypiPackages } },
      },
    });
  }
  if (
    nextSoftware?.airflowConfigOverrides !== undefined &&
    mapKey(nextSoftware.airflowConfigOverrides) !==
      mapKey(currentSoftware?.airflowConfigOverrides)
  ) {
    patches.push({
      mask: "config.softwareConfig.airflowConfigOverrides",
      body: {
        config: {
          softwareConfig: {
            airflowConfigOverrides: nextSoftware.airflowConfigOverrides,
          },
        },
      },
    });
  }
  if (
    nextSoftware?.envVariables !== undefined &&
    mapKey(nextSoftware.envVariables) !== mapKey(currentSoftware?.envVariables)
  ) {
    patches.push({
      mask: "config.softwareConfig.envVariables",
      body: {
        config: { softwareConfig: { envVariables: nextSoftware.envVariables } },
      },
    });
  }
  if (
    nextSoftware?.imageVersion !== undefined &&
    !imageVersionMatches(
      nextSoftware.imageVersion,
      currentSoftware?.imageVersion,
    )
  ) {
    patches.push({
      mask: "config.softwareConfig.imageVersion",
      body: {
        config: { softwareConfig: { imageVersion: nextSoftware.imageVersion } },
      },
    });
  }
  if (
    nextSoftware?.schedulerCount !== undefined &&
    (currentSoftware?.schedulerCount ?? 0) !== nextSoftware.schedulerCount
  ) {
    patches.push({
      mask: "config.softwareConfig.schedulerCount",
      body: {
        config: {
          softwareConfig: { schedulerCount: nextSoftware.schedulerCount },
        },
      },
    });
  }
  if (
    nextSoftware?.cloudDataLineageIntegration !== undefined &&
    jsonKey(nextSoftware.cloudDataLineageIntegration) !==
      jsonKey(currentSoftware?.cloudDataLineageIntegration)
  ) {
    patches.push({
      mask: "config.softwareConfig.cloudDataLineageIntegration",
      body: {
        config: {
          softwareConfig: {
            cloudDataLineageIntegration:
              nextSoftware.cloudDataLineageIntegration,
          },
        },
      },
    });
  }
  if (
    nextSoftware?.webServerPluginsMode !== undefined &&
    pluginsOf(nextSoftware.webServerPluginsMode) !==
      pluginsOf(currentSoftware?.webServerPluginsMode)
  ) {
    patches.push({
      mask: "config.softwareConfig.webServerPluginsMode",
      body: {
        config: {
          softwareConfig: {
            webServerPluginsMode: nextSoftware.webServerPluginsMode,
          },
        },
      },
    });
  }

  const nextConfig = news.config;
  if (
    nextConfig?.nodeCount !== undefined &&
    (current.config?.nodeCount ?? 0) !== nextConfig.nodeCount
  ) {
    patches.push({
      mask: "config.nodeCount",
      body: { config: { nodeCount: nextConfig.nodeCount } },
    });
  }
  if (
    nextConfig?.webServerNetworkAccessControl !== undefined &&
    jsonKey(nextConfig.webServerNetworkAccessControl) !==
      jsonKey(current.config?.webServerNetworkAccessControl)
  ) {
    patches.push({
      mask: "config.webServerNetworkAccessControl",
      body: {
        config: {
          webServerNetworkAccessControl:
            nextConfig.webServerNetworkAccessControl,
        },
      },
    });
  }
  if (
    nextConfig?.databaseConfig?.machineType !== undefined &&
    (current.config?.databaseConfig?.machineType ?? "") !==
      nextConfig.databaseConfig.machineType
  ) {
    patches.push({
      mask: "config.databaseConfig.machineType",
      body: {
        config: {
          databaseConfig: {
            machineType: nextConfig.databaseConfig.machineType,
          },
        },
      },
    });
  }
  if (
    nextConfig?.webServerConfig?.machineType !== undefined &&
    (current.config?.webServerConfig?.machineType ?? "") !==
      nextConfig.webServerConfig.machineType
  ) {
    patches.push({
      mask: "config.webServerConfig.machineType",
      body: {
        config: {
          webServerConfig: {
            machineType: nextConfig.webServerConfig.machineType,
          },
        },
      },
    });
  }
  if (
    nextConfig?.maintenanceWindow !== undefined &&
    jsonKey(nextConfig.maintenanceWindow) !==
      jsonKey(current.config?.maintenanceWindow)
  ) {
    patches.push({
      mask: "config.maintenanceWindow",
      body: { config: { maintenanceWindow: nextConfig.maintenanceWindow } },
    });
  }
  if (
    nextConfig?.workloadsConfig !== undefined &&
    jsonKey(nextConfig.workloadsConfig) !==
      jsonKey(current.config?.workloadsConfig)
  ) {
    patches.push({
      mask: "config.workloadsConfig",
      body: { config: { workloadsConfig: nextConfig.workloadsConfig } },
    });
  }
  if (
    nextConfig?.environmentSize !== undefined &&
    sizeOf(nextConfig.environmentSize) !==
      sizeOf(current.config?.environmentSize)
  ) {
    patches.push({
      mask: "config.environmentSize",
      body: { config: { environmentSize: nextConfig.environmentSize } },
    });
  }
  if (
    nextConfig?.resilienceMode !== undefined &&
    resilienceOf(nextConfig.resilienceMode) !==
      resilienceOf(current.config?.resilienceMode)
  ) {
    patches.push({
      mask: "config.resilienceMode",
      body: { config: { resilienceMode: nextConfig.resilienceMode } },
    });
  }
  if (
    nextConfig?.masterAuthorizedNetworksConfig !== undefined &&
    jsonKey(nextConfig.masterAuthorizedNetworksConfig) !==
      jsonKey(current.config?.masterAuthorizedNetworksConfig)
  ) {
    patches.push({
      mask: "config.masterAuthorizedNetworksConfig",
      body: {
        config: {
          masterAuthorizedNetworksConfig:
            nextConfig.masterAuthorizedNetworksConfig,
        },
      },
    });
  }
  if (
    nextConfig?.recoveryConfig !== undefined &&
    jsonKey(nextConfig.recoveryConfig) !==
      jsonKey(current.config?.recoveryConfig)
  ) {
    patches.push({
      mask: "config.recoveryConfig",
      body: { config: { recoveryConfig: nextConfig.recoveryConfig } },
    });
  }
  if (
    nextConfig?.dataRetentionConfig !== undefined &&
    jsonKey(nextConfig.dataRetentionConfig) !==
      jsonKey(current.config?.dataRetentionConfig)
  ) {
    patches.push({
      mask: "config.dataRetentionConfig",
      body: {
        config: { dataRetentionConfig: nextConfig.dataRetentionConfig },
      },
    });
  }

  return patches;
};

export const EnvironmentProvider = () =>
  Provider.succeed(Environment, {
    stables: [
      "name",
      "environmentId",
      "project",
      "location",
      "uuid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;

      const previousId = olds?.environmentId ?? output?.environmentId;
      const nextId = news.environmentId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        immutableChanged(news, olds, output);

      if (!replace) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          previousLocation === nextLocation &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const environmentId = yield* toId(
        id,
        olds?.environmentId,
        output?.environmentId,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, environmentId);
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
        const pages = yield* Effect.forEach(
          Array.from(new Set<string>([...LIST_LOCATIONS, env.region])),
          (location) => listOwnedAt(env.project, location),
          { concurrency: 8 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const environmentId = yield* toId(
        id,
        news.environmentId,
        output?.environmentId,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, environmentId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* composer
          .createProjectsLocationsEnvironments({
            parent: `projects/${env.project}/locations/${location}`,
            body: {
              name,
              labels: desiredLabels,
              config: toCreateConfig(news.config),
              storageConfig: news.storageConfig,
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
        current = yield* waitUntilRunning(name);
      }

      if (current === undefined) {
        return yield* new EnvironmentNotResolved({ name });
      }

      if (current.state === "ERROR") {
        return yield* new EnvironmentFailed({
          name,
          state: current.state,
        });
      }

      if (current.state !== "RUNNING") {
        current = yield* waitUntilRunning(name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const patches = desiredPatches(
        news,
        current,
        desiredLabels,
        labelsChanged,
      );

      for (const patch of patches) {
        const operation = yield* composer
          .patchProjectsLocationsEnvironments({
            name: current.name ?? name,
            updateMask: patch.mask,
            body: patch.body,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilRunning(current.name ?? name);
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* composer
        .deleteProjectsLocationsEnvironments({ name: output.name })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("5 seconds"),
          }),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): the environment was already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(output.name);
    }),
  });
