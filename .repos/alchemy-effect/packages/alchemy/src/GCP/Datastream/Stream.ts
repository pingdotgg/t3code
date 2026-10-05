import * as ds from "@distilled.cloud/gcp/datastream_v1";
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
  collectPages,
  connectionProfileOf,
  emptyMessage,
  fieldMask,
  fingerprint,
  hasAlchemyLabelMap,
  lastSegment,
  listAtLocation,
  locationParent,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  settleOperation,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type StreamState = ds.StreamStateEnum | (string & {});
export type SourceConfig = ds.SourceConfig;
export type DestinationConfig = ds.DestinationConfig;
export type BackfillAllStrategy = ds.BackfillAllStrategy;
export type BigQueryDestinationConfig = ds.BigQueryDestinationConfig;
export type GcsDestinationConfig = ds.GcsDestinationConfig;
export type MysqlSourceConfig = ds.MysqlSourceConfig;
export type PostgresqlSourceConfig = ds.PostgresqlSourceConfig;
export type OracleSourceConfig = ds.OracleSourceConfig;
export type SqlServerSourceConfig = ds.SqlServerSourceConfig;
export type MongodbSourceConfig = ds.MongodbSourceConfig;
export type SpannerSourceConfig = ds.SpannerSourceConfig;
export type SalesforceSourceConfig = ds.SalesforceSourceConfig;
export type SalesforceMarketingCloudSourceConfig =
  ds.SalesforceMarketingCloudSourceConfig;
export type ServiceNowSourceConfig = ds.ServiceNowSourceConfig;
export type RuleSet = ds.RuleSet;
export type DatastreamError = ds.Datastream_Error;

export type StreamProps = {
  /**
   * Stream id (the `{stream}` segment of
   * `projects/{project}/locations/{location}/streams/{stream}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing it
   * replaces the stream.
   */
  streamId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * stream. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Source connection profile and engine-specific include/exclude
   * objects. `sourceConnectionProfile` may be a full name or id
   * (combined with `location`). Changing the source profile replaces the
   * stream; other source config updates in place.
   */
  sourceConfig: SourceConfig;
  /**
   * Destination connection profile and BigQuery / GCS writer config.
   * `destinationConnectionProfile` may be a full name or id (combined
   * with `location`). Changing the destination profile replaces the
   * stream; other destination config updates in place.
   */
  destinationConfig: DestinationConfig;
  /**
   * Automatically backfill objects included in the source config.
   * Mutually exclusive with `backfillNone`.
   */
  backfillAll?: BackfillAllStrategy;
  /**
   * Do not automatically backfill any objects. Mutually exclusive with
   * `backfillAll`.
   */
  backfillNone?: Record<string, never>;
  /**
   * Customer-managed Cloud KMS key used to encrypt stream data.
   * Immutable — changing it replaces the stream.
   */
  customerManagedEncryptionKey?: string;
  /**
   * Customization rule sets applied to stream objects.
   */
  ruleSets?: ReadonlyArray<RuleSet>;
  /**
   * Desired stream state (`NOT_STARTED`, `RUNNING`, `PAUSED`, …).
   */
  state?: StreamState;
  /**
   * Create or update without validating connectivity.
   */
  force?: boolean;
  /**
   * Validate without creating or updating resources.
   */
  validateOnly?: boolean;
};

export type Stream = Resource<
  "GCP.Datastream.Stream",
  StreamProps,
  {
    /** Full resource name. */
    name: string;
    /** Stream id (last path segment). */
    streamId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Source connection profile and engine config. */
    sourceConfig: SourceConfig | undefined;
    /** Destination connection profile and writer config. */
    destinationConfig: DestinationConfig | undefined;
    /** Backfill-all strategy. */
    backfillAll: BackfillAllStrategy | undefined;
    /** Backfill-none strategy. */
    backfillNone: Record<string, never> | undefined;
    /** Customer-managed encryption key. */
    customerManagedEncryptionKey: string | undefined;
    /** Customization rule sets. */
    ruleSets: ReadonlyArray<RuleSet> | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Errors on the stream. */
    errors: ReadonlyArray<DatastreamError> | undefined;
    /** RFC3339 last recovery timestamp. */
    lastRecoveryTime: string | undefined;
    /** Whether the stream satisfies physical zone isolation. */
    satisfiesPzi: boolean | undefined;
    /** Whether the stream satisfies physical zone separation. */
    satisfiesPzs: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Datastream stream: continuously replicates data from a source
 * connection profile to a BigQuery or Cloud Storage destination.
 *
 * `streamId`, `location`, `customerManagedEncryptionKey`, and the source
 * / destination connection profile identities are replacement triggers.
 * Display name, labels, include/exclude objects, backfill strategy,
 * rule sets, and desired `state` update in place.
 *
 * ### Creating a Stream
 * **Example:** MySQL to BigQuery
 * ```typescript
 * const source = yield* GCP.Datastream.ConnectionProfile("MysqlSrc", {
 *   mysqlProfile: {
 *     hostname: "10.0.0.8",
 *     username: "datastream",
 *     password: process.env.MYSQL_PASSWORD,
 *   },
 *   force: true,
 * });
 * const dest = yield* GCP.Datastream.ConnectionProfile("BqDest", {
 *   bigqueryProfile: {},
 * });
 * const stream = yield* GCP.Datastream.Stream("MysqlToBq", {
 *   sourceConfig: {
 *     sourceConnectionProfile: source.name,
 *     mysqlSourceConfig: {
 *       includeObjects: { mysqlDatabases: [{ database: "app" }] },
 *     },
 *   },
 *   destinationConfig: {
 *     destinationConnectionProfile: dest.name,
 *     bigqueryDestinationConfig: {
 *       singleTargetDataset: { datasetId: "app_replica" },
 *     },
 *   },
 *   backfillAll: {},
 *   force: true,
 * });
 * ```
 *
 * @resource
 * @category Datastream
 */
export const Stream = Resource<Stream>("GCP.Datastream.Stream");

const resourceName = (project: string, location: string, streamId: string) =>
  `${locationParent(project, location)}/streams/${streamId}`;

const expandSource = (
  config: SourceConfig,
  project: string,
  location: string,
): SourceConfig => ({
  ...config,
  sourceConnectionProfile: config.sourceConnectionProfile
    ? connectionProfileOf(config.sourceConnectionProfile, project, location)
    : undefined,
});

const expandDestination = (
  config: DestinationConfig,
  project: string,
  location: string,
): DestinationConfig => ({
  ...config,
  destinationConnectionProfile: config.destinationConnectionProfile
    ? connectionProfileOf(
        config.destinationConnectionProfile,
        project,
        location,
      )
    : undefined,
});

const profileIdOf = (value: string | undefined) => lastSegment(value ?? "");

const toAttrs = (item: ds.Stream, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "streams", region);
  return {
    name,
    streamId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    sourceConfig: item.sourceConfig,
    destinationConfig: item.destinationConfig,
    backfillAll: item.backfillAll,
    backfillNone: emptyMessage(item.backfillNone),
    customerManagedEncryptionKey: item.customerManagedEncryptionKey,
    ruleSets: item.ruleSets,
    state: item.state,
    errors: item.errors,
    lastRecoveryTime: item.lastRecoveryTime,
    satisfiesPzi: item.satisfiesPzi,
    satisfiesPzs: item.satisfiesPzs,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ds
        .getProjectsLocationsStreams({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    collectPages(
      ds.listProjectsLocationsStreams.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.streams,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    ),
  );

const sourceConfigWithoutProfile = (config: SourceConfig | undefined) => {
  if (config === undefined) return undefined;
  const { sourceConnectionProfile: _ignored, ...rest } = config;
  return rest;
};

const destinationConfigWithoutProfile = (
  config: DestinationConfig | undefined,
) => {
  if (config === undefined) return undefined;
  const { destinationConnectionProfile: _ignored, ...rest } = config;
  return rest;
};

export const StreamProvider = () =>
  Provider.succeed(Stream, {
    stables: ["name", "streamId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousSource = profileIdOf(
        olds?.sourceConfig?.sourceConnectionProfile ??
          output?.sourceConfig?.sourceConnectionProfile,
      );
      const nextSource = profileIdOf(
        news.sourceConfig.sourceConnectionProfile ??
          olds?.sourceConfig?.sourceConnectionProfile ??
          output?.sourceConfig?.sourceConnectionProfile,
      );
      const previousDest = profileIdOf(
        olds?.destinationConfig?.destinationConnectionProfile ??
          output?.destinationConfig?.destinationConnectionProfile,
      );
      const nextDest = profileIdOf(
        news.destinationConfig.destinationConnectionProfile ??
          olds?.destinationConfig?.destinationConnectionProfile ??
          output?.destinationConfig?.destinationConnectionProfile,
      );
      const previousCmek =
        olds?.customerManagedEncryptionKey ??
        output?.customerManagedEncryptionKey;
      const nextCmek = news.customerManagedEncryptionKey ?? previousCmek;
      return replaceOnIdentity({
        previousId: olds?.streamId ?? output?.streamId,
        nextId: news.streamId ?? olds?.streamId ?? output?.streamId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (previousSource.length > 0 &&
            nextSource.length > 0 &&
            previousSource !== nextSource) ||
          (previousDest.length > 0 &&
            nextDest.length > 0 &&
            previousDest !== nextDest) ||
          (previousCmek !== undefined &&
            nextCmek !== undefined &&
            previousCmek !== nextCmek) ||
          (previousCmek === undefined && nextCmek !== undefined),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const streamId = yield* toPhysicalId(
        id,
        olds?.streamId,
        output?.streamId,
        "stream",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, streamId);
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
      const streamId = yield* toPhysicalId(
        id,
        news.streamId,
        output?.streamId,
        "stream",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, streamId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const displayName = news.displayName ?? streamId;
      const sourceConfig = expandSource(
        news.sourceConfig,
        env.project,
        location,
      );
      const destinationConfig = expandDestination(
        news.destinationConfig,
        env.project,
        location,
      );

      let current = yield* getByName(output?.name ?? name);

      const backfillAll =
        news.backfillAll !== undefined
          ? news.backfillAll
          : news.backfillNone !== undefined
            ? undefined
            : current?.backfillAll;
      const backfillNone =
        news.backfillNone !== undefined
          ? {}
          : news.backfillAll !== undefined
            ? undefined
            : (emptyMessage(current?.backfillNone) ??
              (current?.backfillAll === undefined ? {} : undefined));
      const body: ds.Stream = {
        displayName,
        labels: desiredLabels,
        sourceConfig,
        destinationConfig,
        backfillAll,
        backfillNone: backfillAll === undefined ? backfillNone : undefined,
        customerManagedEncryptionKey: news.customerManagedEncryptionKey,
        ruleSets: news.ruleSets ? [...news.ruleSets] : undefined,
        state: news.state,
      };

      if (current === undefined) {
        const created = yield* ds
          .createProjectsLocationsStreams({
            parent: locationParent(env.project, location),
            streamId,
            force: news.force,
            validateOnly: news.validateOnly,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        yield* settleOperation(created);
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const sourceChanged =
        fingerprint(sourceConfigWithoutProfile(current.sourceConfig)) !==
        fingerprint(sourceConfigWithoutProfile(sourceConfig));
      const destinationChanged =
        fingerprint(
          destinationConfigWithoutProfile(current.destinationConfig),
        ) !== fingerprint(destinationConfigWithoutProfile(destinationConfig));
      const backfillChanged =
        fingerprint({
          backfillAll: current.backfillAll,
          backfillNone: emptyMessage(current.backfillNone),
        }) !==
        fingerprint({
          backfillAll,
          backfillNone: backfillAll === undefined ? backfillNone : undefined,
        });
      const ruleSetsChanged =
        fingerprint(current.ruleSets) !== fingerprint(news.ruleSets);
      const stateChanged =
        news.state !== undefined && (current.state ?? "") !== news.state;
      const mask = fieldMask([
        labelsChanged && "labels",
        displayNameChanged && "displayName",
        sourceChanged && "sourceConfig",
        destinationChanged && "destinationConfig",
        backfillChanged &&
          (backfillAll !== undefined ? "backfillAll" : "backfillNone"),
        ruleSetsChanged && "ruleSets",
        stateChanged && "state",
      ]);

      if (mask.length > 0) {
        const patch: ds.Stream = { name: current.name ?? name };
        if (labelsChanged) patch.labels = desiredLabels;
        if (displayNameChanged) patch.displayName = displayName;
        if (sourceChanged) patch.sourceConfig = sourceConfig;
        if (destinationChanged) patch.destinationConfig = destinationConfig;
        if (backfillChanged) {
          patch.backfillAll = backfillAll;
          patch.backfillNone =
            backfillAll === undefined ? backfillNone : undefined;
        }
        if (ruleSetsChanged) {
          patch.ruleSets = news.ruleSets ? [...news.ruleSets] : undefined;
        }
        if (stateChanged) patch.state = news.state;
        const operation = yield* ds.patchProjectsLocationsStreams({
          name: current.name ?? name,
          updateMask: mask,
          force: news.force,
          validateOnly: news.validateOnly,
          body: patch,
        });
        yield* settleOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* ds
        .deleteProjectsLocationsStreams({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag(["NotFound", "Conflict"], () =>
            Effect.succeed(undefined),
          ),
        );
      // Stream deletes take a few minutes.
      yield* settleOperation(operation, { notFoundOk: true });
      yield* waitUntilGone(getByName(output.name), output.name, {
        times: 15,
        interval: "4 seconds",
      });
    }),
  });
