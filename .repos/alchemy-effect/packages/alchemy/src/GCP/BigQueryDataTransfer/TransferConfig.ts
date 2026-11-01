import * as bqdt from "@distilled.cloud/gcp/bigquerydatatransfer_v1";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const backoff = Schedule.min([
  Schedule.exponential(Duration.millis(300), 1.5),
  Schedule.spaced(Duration.seconds(2)),
]);

export type TransferParams = Record<string, unknown>;

export type EmailPreferences = {
  /**
   * Send email to the config owner when a transfer run fails.
   */
  enableFailureEmail?: boolean;
};

export type ScheduleOptions = {
  /**
   * Disable automatic scheduling. Runs can still be started with
   * StartManualTransferRuns. When true, `schedule` is ignored.
   */
  disableAutoScheduling?: boolean;
  /**
   * RFC3339 time to start scheduling runs. The first run is at or after
   * this time according to `schedule`.
   */
  startTime?: string;
  /**
   * RFC3339 time to stop scheduling runs. A run is not scheduled at or
   * after this time.
   */
  endTime?: string;
};

export type EventDrivenSchedule = {
  /**
   * Pub/Sub subscription that triggers runs. Only `google_cloud_storage`
   * supports this. Format: `projects/{project}/subscriptions/{subscription}`.
   */
  pubsubSubscription?: string;
};

export type TimeBasedSchedule = {
  /** RFC3339 time to start scheduling runs. */
  startTime?: string;
  /** RFC3339 time to stop scheduling runs. */
  endTime?: string;
  /**
   * Recurrence in UTC (e.g. `"every 24 hours"`, `"first sunday of quarter
   * 00:00"`). Empty uses the data source default.
   */
  schedule?: string;
};

export type ScheduleOptionsV2 = {
  /**
   * Event-driven schedule. Cannot be combined with `timeBasedSchedule` or
   * `manualSchedule`.
   */
  eventDrivenSchedule?: EventDrivenSchedule;
  /**
   * Time-based schedule. Cannot be combined with `eventDrivenSchedule` or
   * `manualSchedule`. Replaces top-level `schedule` / `scheduleOptions`.
   */
  timeBasedSchedule?: TimeBasedSchedule;
  /**
   * Manual schedule (equivalent to `disableAutoScheduling: true`). Empty
   * object selects this mode.
   */
  manualSchedule?: Record<string, never>;
};

export type EncryptionConfiguration = {
  /**
   * Cloud KMS key used to encrypt transferred BigQuery data, as
   * `projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`.
   */
  kmsKeyName?: string;
};

export type DataplexConfiguration = {
  /**
   * Dataplex Universal Catalog entry group, as
   * `projects/{project}/locations/{region}/entryGroups/{entryGroup}`.
   */
  entryGroup?: string;
};

export type MetadataDestination = {
  /** Dataplex Universal Catalog destination. */
  dataplexConfiguration?: DataplexConfiguration;
};

export type ManagedTableType =
  | "MANAGED_TABLE_TYPE_UNSPECIFIED"
  | "NATIVE"
  | "BIGLAKE"
  | (string & {});

export type TransferConfigProps = {
  /**
   * Data Transfer location (`us-central1`, `us-east1`, `us`, …). Must
   * match the destination dataset location. Immutable — changing it
   * replaces the config. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Data source id (e.g. `"scheduled_query"`, `"google_cloud_storage"`).
   * Immutable — changing it replaces the config. The full list is
   * available from `projects.locations.dataSources.list`.
   */
  dataSourceId: string;
  /**
   * User-specified display name. Transfer configs have no labels field,
   * so Alchemy ownership (`alchemy-stack` / `alchemy-stage` /
   * `alchemy-id`) is stored in a `[alchemy …]` prefix for `read` /
   * `list` / nuke.
   */
  displayName?: string;
  /**
   * Destination BigQuery dataset id. Required for most data sources
   * (including scheduled queries and Cloud Storage). Must live in the
   * same location as this config.
   */
  destinationDatasetId?: string;
  /**
   * Parameters specific to `dataSourceId`. Values are typically strings.
   * Scheduled query: `query`, `destination_table_name_template`,
   * `write_disposition`. Cloud Storage: `data_path_template`,
   * `destination_table_name_template`, `file_format`.
   */
  params: TransferParams;
  /**
   * Recurrence in UTC (e.g. `"every 24 hours"`). Empty uses the data
   * source default. Ignored when `scheduleOptions.disableAutoScheduling`
   * is true. Do not set together with `scheduleOptionsV2`.
   */
  schedule?: string;
  /**
   * Time-window and auto-schedule options. Do not set together with
   * `scheduleOptionsV2`.
   */
  scheduleOptions?: ScheduleOptions;
  /**
   * V2 schedule (time-based, event-driven, or manual). Replaces
   * `schedule` and `scheduleOptions` — the two families cannot be
   * combined.
   */
  scheduleOptionsV2?: ScheduleOptionsV2;
  /**
   * Days of data to refresh on each run. `0` uses the data source
   * default. Only valid when the data source supports it.
   */
  dataRefreshWindowDays?: number;
  /**
   * When true, the config exists but no runs are scheduled.
   * @default false
   */
  disabled?: boolean;
  /**
   * Pub/Sub topic notified when a run finishes, as
   * `projects/{project}/topics/{topic}`.
   */
  notificationPubsubTopic?: string;
  /**
   * Email notification preferences for the config owner.
   */
  emailPreferences?: EmailPreferences;
  /**
   * Optional CMEK for transferred BigQuery data.
   */
  encryptionConfiguration?: EncryptionConfiguration;
  /**
   * Classification of the destination table (`NATIVE`, `BIGLAKE`).
   */
  managedTableType?: ManagedTableType;
  /**
   * Metadata destination (Dataplex) when the transfer writes catalog
   * metadata rather than a dataset.
   */
  metadataDestination?: MetadataDestination;
  /**
   * Service account the transfer runs as. The caller needs
   * `iam.serviceAccounts.actAs`. Not all data sources support this;
   * omitted uses the caller's credentials. Not returned by get — passed
   * on create and whenever it changes.
   */
  serviceAccountName?: string;
  /**
   * OAuth version info for data sources that need user credentials
   * (e.g. `youtube_channel`). Do not set with `serviceAccountName`.
   */
  versionInfo?: string;
  /**
   * Deprecated OAuth authorization code. Prefer `versionInfo`.
   */
  authorizationCode?: string;
};

export type TransferConfig = Resource<
  "GCP.BigQueryDataTransfer.TransferConfig",
  TransferConfigProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/transferConfigs/{id}`. */
    name: string;
    /** Server-assigned config id (last path segment, usually a UUID). */
    transferConfigId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Data source id. */
    dataSourceId: string | undefined;
    /** Destination dataset id. */
    destinationDatasetId: string | undefined;
    /** Data-source parameters currently stored on the config. */
    params: TransferParams;
    /** Recurrence string. */
    schedule: string | undefined;
    /** Time-window / auto-schedule options. */
    scheduleOptions: ScheduleOptions | undefined;
    /** V2 schedule options. */
    scheduleOptionsV2: ScheduleOptionsV2 | undefined;
    /** Refresh window in days. */
    dataRefreshWindowDays: number | undefined;
    /** Whether the config is disabled. */
    disabled: boolean;
    /** Run-completion Pub/Sub topic. */
    notificationPubsubTopic: string | undefined;
    /** Email notification preferences. */
    emailPreferences: EmailPreferences | undefined;
    /** CMEK configuration. */
    encryptionConfiguration: EncryptionConfiguration | undefined;
    /** Destination table classification. */
    managedTableType: string | undefined;
    /** Metadata destination. */
    metadataDestination: MetadataDestination | undefined;
    /** Region of the destination dataset. */
    datasetRegion: string | undefined;
    /** Next scheduled run (RFC3339). */
    nextRunTime: string | undefined;
    /** State of the most recently updated run. */
    state: string | undefined;
    /** Last modification time (RFC3339). */
    updateTime: string | undefined;
    /** Deprecated user id. */
    userId: string | undefined;
    /** Owner whose credentials the transfer uses. */
    ownerInfo: bqdt.UserInfo | undefined;
    /** Latest config-level error, if any. */
    error: bqdt.Status | undefined;
  },
  never,
  Providers
>;

/**
 * A BigQuery Data Transfer Service transfer configuration.
 *
 * Transfer configs have no labels field — Alchemy stamps ownership into
 * the display name (`[alchemy alchemy-stack=… alchemy-stage=…
 * alchemy-id=…]`) so `read`, `list`, and `pnpm nuke:gcp` can find them.
 * The physical id is a server-assigned UUID. `dataSourceId` and
 * `location` are immutable; changing either replaces the config.
 *
 * ### Creating a Transfer Config
 * **Example:** Scheduled query with auto-scheduling disabled
 * ```typescript
 * const dataset = yield* GCP.BigQuery.Dataset("Analytics", {
 *   location: "US-CENTRAL1",
 *   forceDestroy: true,
 * });
 * const nightly = yield* GCP.BigQueryDataTransfer.TransferConfig("Nightly", {
 *   dataSourceId: "scheduled_query",
 *   destinationDatasetId: dataset.datasetId,
 *   displayName: "nightly",
 *   schedule: "every 24 hours",
 *   scheduleOptions: { disableAutoScheduling: true },
 *   params: {
 *     query: "SELECT 1 AS n",
 *     destination_table_name_template: "nightly",
 *     write_disposition: "WRITE_TRUNCATE",
 *   },
 * });
 * ```
 *
 * **Example:** Cloud Storage load
 * ```typescript
 * const load = yield* GCP.BigQueryDataTransfer.TransferConfig("GcsLoad", {
 *   dataSourceId: "google_cloud_storage",
 *   destinationDatasetId: dataset.datasetId,
 *   schedule: "every 24 hours",
 *   scheduleOptions: { disableAutoScheduling: true },
 *   params: {
 *     data_path_template: "gs://my-bucket/*.csv",
 *     destination_table_name_template: "events",
 *     file_format: "CSV",
 *     skip_leading_rows: "1",
 *     max_bad_records: "0",
 *   },
 * });
 * ```
 *
 * @resource
 * @category BigQueryDataTransfer
 */
export const TransferConfig = Resource<TransferConfig>(
  "GCP.BigQueryDataTransfer.TransferConfig",
);

export class TransferConfigNotResolved extends Data.TaggedError(
  "GCP.BigQueryDataTransfer.TransferConfigNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string) =>
  lastSegment(location).toLowerCase();

const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const configsAt = parts.lastIndexOf("transferConfigs");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1] ? parts[locationsAt + 1]! : "",
    transferConfigId:
      configsAt >= 0 && parts[configsAt + 1]
        ? parts[configsAt + 1]!
        : lastSegment(name),
  };
};

const encodeDisplayName = (
  labels: Record<string, string>,
  displayName: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const trimmed = displayName?.replace(/[\r\n]+/g, " ").trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker} ${trimmed}` : marker;
  return combined.slice(0, 1024);
};

const parseDisplayName = (
  displayName: string | undefined,
): {
  labels: Record<string, string>;
  displayName: string | undefined;
} => {
  if (!displayName?.startsWith("[alchemy ")) {
    return { labels: {}, displayName };
  }
  const end = displayName.indexOf("]");
  if (end < 0) return { labels: {}, displayName };
  const labels: Record<string, string> = {};
  for (const part of displayName.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = displayName.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, displayName: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (displayName: string | undefined): boolean =>
  Object.keys(parseDisplayName(displayName).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;

const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

const canonParams = (params: TransferParams | undefined): TransferParams => {
  const out: TransferParams = {};
  for (const key of Object.keys(params ?? {}).sort()) {
    const value = params![key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
};

const toScheduleOptions = (
  options: bqdt.ScheduleOptions | undefined,
): ScheduleOptions | undefined => {
  if (options === undefined) return undefined;
  if (
    options.disableAutoScheduling === undefined &&
    options.startTime === undefined &&
    options.endTime === undefined
  ) {
    return undefined;
  }
  return compact({
    disableAutoScheduling: options.disableAutoScheduling,
    startTime: options.startTime,
    endTime: options.endTime,
  });
};

const toScheduleOptionsV2 = (
  options: bqdt.ScheduleOptionsV2 | undefined,
): ScheduleOptionsV2 | undefined => {
  if (options === undefined) return undefined;
  const timeBased =
    options.timeBasedSchedule === undefined
      ? undefined
      : compact({
          startTime: options.timeBasedSchedule.startTime,
          endTime: options.timeBasedSchedule.endTime,
          schedule: options.timeBasedSchedule.schedule,
        });
  const eventDriven =
    options.eventDrivenSchedule === undefined
      ? undefined
      : compact({
          pubsubSubscription: options.eventDrivenSchedule.pubsubSubscription,
        });
  const manual =
    options.manualSchedule === undefined
      ? undefined
      : ({} as Record<string, never>);
  if (
    timeBased === undefined &&
    eventDriven === undefined &&
    manual === undefined
  ) {
    return undefined;
  }
  return compact({
    timeBasedSchedule:
      timeBased && Object.keys(timeBased).length > 0 ? timeBased : undefined,
    eventDrivenSchedule:
      eventDriven && Object.keys(eventDriven).length > 0
        ? eventDriven
        : undefined,
    manualSchedule: manual,
  });
};

const toEmailPreferences = (
  preferences: bqdt.EmailPreferences | undefined,
): EmailPreferences | undefined => {
  if (preferences === undefined) return undefined;
  if (preferences.enableFailureEmail === undefined) return undefined;
  return { enableFailureEmail: preferences.enableFailureEmail };
};

const toEncryption = (
  encryption: bqdt.EncryptionConfiguration | undefined,
): EncryptionConfiguration | undefined => {
  if (encryption?.kmsKeyName === undefined) return undefined;
  return { kmsKeyName: encryption.kmsKeyName };
};

const toMetadataDestination = (
  destination: bqdt.MetadataDestination | undefined,
): MetadataDestination | undefined => {
  const entryGroup = destination?.dataplexConfiguration?.entryGroup;
  if (entryGroup === undefined) return undefined;
  return { dataplexConfiguration: { entryGroup } };
};

const toAttrs = (
  config: bqdt.TransferConfig,
  project: string,
  location: string,
) => {
  const name = config.name ?? "";
  const parsed = parseName(name);
  const { displayName } = parseDisplayName(config.displayName);
  return {
    name,
    transferConfigId: parsed.transferConfigId,
    project: parsed.project || project,
    location: parsed.location || location,
    displayName,
    dataSourceId: config.dataSourceId,
    destinationDatasetId: config.destinationDatasetId,
    params: config.params ?? {},
    schedule: config.schedule,
    scheduleOptions: toScheduleOptions(config.scheduleOptions),
    scheduleOptionsV2: toScheduleOptionsV2(config.scheduleOptionsV2),
    dataRefreshWindowDays: config.dataRefreshWindowDays,
    disabled: config.disabled === true,
    notificationPubsubTopic: config.notificationPubsubTopic,
    emailPreferences: toEmailPreferences(config.emailPreferences),
    encryptionConfiguration: toEncryption(config.encryptionConfiguration),
    managedTableType: config.managedTableType,
    metadataDestination: toMetadataDestination(config.metadataDestination),
    datasetRegion: config.datasetRegion,
    nextRunTime: config.nextRunTime,
    state: config.state,
    updateTime: config.updateTime,
    userId: config.userId,
    ownerInfo: config.ownerInfo,
    error: config.error,
  };
};

const getByName = (name: string) =>
  bqdt
    .getProjectsLocationsTransferConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string) =>
  bqdt.listProjectsLocationsTransferConfigs
    .pages({
      parent,
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.transferConfigs ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as bqdt.TransferConfig[]),
      ),
    );

const findOwned = Effect.fn(function* (
  parent: string,
  id: string,
  dataSourceId: string | undefined,
) {
  const configs = yield* listAt(parent);
  for (const config of configs) {
    const { labels } = parseDisplayName(config.displayName);
    if (!(yield* hasAlchemyLabels(id, labels))) continue;
    if (
      dataSourceId !== undefined &&
      (config.dataSourceId ?? "") !== dataSourceId
    ) {
      continue;
    }
    if (config.name === undefined) continue;
    // List can lag a delete; confirm the config still exists.
    return yield* getByName(config.name);
  }
  return undefined;
});

const toBody = (
  news: TransferConfigProps,
  displayName: string,
): bqdt.TransferConfig =>
  compact({
    displayName,
    dataSourceId: news.dataSourceId,
    destinationDatasetId: news.destinationDatasetId,
    params: news.params,
    schedule: news.schedule,
    scheduleOptions: news.scheduleOptions,
    scheduleOptionsV2: news.scheduleOptionsV2,
    dataRefreshWindowDays: news.dataRefreshWindowDays,
    disabled: news.disabled === true ? true : news.disabled,
    notificationPubsubTopic: news.notificationPubsubTopic,
    emailPreferences: news.emailPreferences,
    encryptionConfiguration: news.encryptionConfiguration,
    managedTableType: news.managedTableType,
    metadataDestination: news.metadataDestination,
  }) as bqdt.TransferConfig;

const retryTransient = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "NotFound" || error._tag === "Conflict",
      times: 8,
      schedule: backoff,
    }),
  );

const listLocationParents = (project: string, region: string) =>
  bqdt.listProjectsLocations
    .pages({
      name: `projects/${project}`,
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.locations ?? [])),
      Stream.map((location) => location.name),
      Stream.filter((name): name is string => !!name && name.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([parentOf(project, region)]),
      ),
    );

export const TransferConfigProvider = () =>
  Provider.succeed(TransferConfig, {
    stables: [
      "name",
      "transferConfigId",
      "project",
      "location",
      "dataSourceId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation =
        typeof news.location === "string" ? news.location : undefined;
      if (
        previousLocation !== undefined &&
        nextLocation !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(nextLocation)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }

      const previousSource = olds?.dataSourceId ?? output?.dataSourceId;
      const nextSource =
        typeof news.dataSourceId === "string" ? news.dataSourceId : undefined;
      if (
        previousSource !== undefined &&
        nextSource !== undefined &&
        nextSource !== previousSource
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const parent = parentOf(env.project, location);
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : yield* findOwned(parent, id, olds?.dataSourceId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      return (yield* hasAlchemyLabels(
        id,
        parseDisplayName(existing.displayName).labels,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const parents = yield* listLocationParents(env.project, env.region);
        const unique =
          parents.length > 0
            ? [...new Set(parents)]
            : [parentOf(env.project, env.region)];
        const pages = yield* Effect.forEach(
          unique,
          (parent) => listAt(parent),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((config) => hasOwnershipMarker(config.displayName))
          .map((config) => toAttrs(config, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output, olds }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const parent = parentOf(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const desiredDisplayName = encodeDisplayName(ownership, news.displayName);
      const desiredDisabled = news.disabled === true;
      const desiredBody = toBody(
        { ...news, disabled: desiredDisabled },
        desiredDisplayName,
      );

      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;
      if (current === undefined) {
        current = yield* findOwned(parent, id, news.dataSourceId);
      }

      if (current === undefined) {
        const created = yield* bqdt
          .createProjectsLocationsTransferConfigs({
            parent,
            serviceAccountName: news.serviceAccountName,
            versionInfo: news.versionInfo,
            authorizationCode: news.authorizationCode,
            body: desiredBody,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(parent, id, news.dataSourceId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TransferConfigNotResolved({
          name: `${parent}/transferConfigs`,
        });
      }

      const name = current.name ?? "";
      const mask: string[] = [];
      if ((current.displayName ?? "") !== desiredDisplayName) {
        mask.push("displayName");
      }
      if (
        (current.destinationDatasetId ?? "") !==
        (news.destinationDatasetId ?? "")
      ) {
        mask.push("destinationDatasetId");
      }
      if (!jsonEqual(canonParams(current.params), canonParams(news.params))) {
        mask.push("params");
      }
      if (
        news.schedule !== undefined &&
        (current.schedule ?? "") !== news.schedule
      ) {
        mask.push("schedule");
      }
      if (
        news.scheduleOptions !== undefined &&
        !jsonEqual(
          toScheduleOptions(current.scheduleOptions) ?? null,
          compact({ ...news.scheduleOptions }),
        )
      ) {
        mask.push("scheduleOptions");
      }
      if (
        news.scheduleOptionsV2 !== undefined &&
        !jsonEqual(
          toScheduleOptionsV2(current.scheduleOptionsV2) ?? null,
          news.scheduleOptionsV2,
        )
      ) {
        mask.push("scheduleOptionsV2");
      }
      if (
        news.dataRefreshWindowDays !== undefined &&
        (current.dataRefreshWindowDays ?? 0) !== news.dataRefreshWindowDays
      ) {
        mask.push("dataRefreshWindowDays");
      }
      if ((current.disabled === true) !== desiredDisabled) {
        mask.push("disabled");
      }
      if (
        news.notificationPubsubTopic !== undefined &&
        (current.notificationPubsubTopic ?? "") !== news.notificationPubsubTopic
      ) {
        mask.push("notificationPubsubTopic");
      }
      if (
        news.emailPreferences !== undefined &&
        !jsonEqual(
          toEmailPreferences(current.emailPreferences) ?? null,
          compact({ ...news.emailPreferences }),
        )
      ) {
        mask.push("emailPreferences");
      }
      if (
        news.encryptionConfiguration !== undefined &&
        (current.encryptionConfiguration?.kmsKeyName ?? "") !==
          (news.encryptionConfiguration.kmsKeyName ?? "")
      ) {
        mask.push("encryptionConfiguration");
      }
      if (
        news.managedTableType !== undefined &&
        (current.managedTableType ?? "") !== news.managedTableType
      ) {
        mask.push("managedTableType");
      }
      if (
        news.metadataDestination !== undefined &&
        !jsonEqual(
          toMetadataDestination(current.metadataDestination) ?? null,
          news.metadataDestination,
        )
      ) {
        mask.push("metadataDestination");
      }

      const serviceAccountChanged =
        (olds?.serviceAccountName ?? "") !== (news.serviceAccountName ?? "");

      if (mask.length > 0 || serviceAccountChanged) {
        current = yield* retryTransient(
          bqdt.patchProjectsLocationsTransferConfigs({
            name,
            updateMask: mask.length > 0 ? mask.join(",") : "displayName",
            serviceAccountName: news.serviceAccountName,
            versionInfo: news.versionInfo,
            authorizationCode: news.authorizationCode,
            body: { ...desiredBody, name },
          }),
        );
        current = (yield* getByName(name)) ?? current;
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* bqdt
        .deleteProjectsLocationsTransferConfigs({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
