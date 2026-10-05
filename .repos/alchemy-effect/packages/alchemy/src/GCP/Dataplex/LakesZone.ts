import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Data from "effect/Data";
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
import { waitForOperation } from "./operations.ts";
import {
  DataplexNotResolved,
  expandParent,
  fingerprint,
  hasAlchemyLabelMap,
  isPendingState,
  listChildResources,
  listLakes,
  listZones,
  normalizeLocation,
  parseResourceName,
  replaceIfChanged,
  toPhysicalRfc1035,
  userLabels,
} from "./shared.ts";

const DEFAULT_TYPE = "RAW";
const DEFAULT_LOCATION_TYPE = "SINGLE_REGION";

export type ZoneDiscoveryCsvOptions = {
  /** Header rows to skip. */
  headerRows?: number;
  /** Field delimiter. @default "," */
  delimiter?: string;
  /** Character encoding. @default "UTF-8" */
  encoding?: string;
  /** Register all columns as strings. */
  disableTypeInference?: boolean;
};

export type ZoneDiscoveryJsonOptions = {
  /** Character encoding. @default "UTF-8" */
  encoding?: string;
  /** Disable type inference. */
  disableTypeInference?: boolean;
};

export type ZoneDiscoverySpec = {
  /**
   * Whether discovery is enabled.
   * @default false
   */
  enabled?: boolean;
  /** Include glob / table-name patterns. */
  includePatterns?: string[];
  /** Exclude glob / table-name patterns. */
  excludePatterns?: string[];
  /** CSV discovery options. */
  csvOptions?: ZoneDiscoveryCsvOptions;
  /** JSON discovery options. */
  jsonOptions?: ZoneDiscoveryJsonOptions;
  /** Cron schedule (at least 60 minutes apart). */
  schedule?: string;
};

export type LakesZoneProps = {
  /**
   * Parent lake. Full name
   * `projects/{project}/locations/{location}/lakes/{lake}` or the lake id
   * (combined with `location`). Immutable — changing it replaces the zone.
   */
  lake: string;
  /**
   * Region used when `lake` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Zone id. Must contain only lowercase letters, numbers, and hyphens;
   * start with a letter; end with a letter or number; and be 1-63
   * characters. Unique across lakes in the project. Immutable — changing
   * it replaces the zone.
   */
  zoneId?: string;
  /**
   * Zone type. Immutable — changing it replaces the zone.
   * @default "RAW"
   */
  type?: dataplex.GoogleCloudDataplexV1ZoneTypeEnum | (string & {});
  /**
   * Location type of attached assets. Immutable — changing it replaces
   * the zone.
   * @default "SINGLE_REGION"
   */
  locationType?:
    | dataplex.GoogleCloudDataplexV1ZoneResourceSpecLocationTypeEnum
    | (string & {});
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Discovery settings applied to data in this zone.
   */
  discoverySpec?: ZoneDiscoverySpec;
};

export type LakesZone = Resource<
  "GCP.Dataplex.LakesZone",
  LakesZoneProps,
  {
    /** Full resource name `.../lakes/{lake}/zones/{zone}`. */
    name: string;
    /** Zone id. */
    zoneId: string;
    /** Parent lake resource name. */
    lake: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Zone type (`RAW` or `CURATED`). */
    type: string;
    /** Attached-asset location type. */
    locationType: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether discovery is enabled. */
    discoveryEnabled: boolean;
    /** Lifecycle state. */
    state: string | undefined;
    /** Server-assigned uid. */
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
 * A Dataplex zone — a logical grouping of assets inside a lake (`RAW` or
 * `CURATED`).
 *
 * Changing `lake`, `zoneId`, `location`, `type`, or `locationType`
 * replaces the zone. Display name, description, labels, and discovery
 * spec update in place.
 *
 * ### Creating a Zone
 * **Example:** RAW zone in a lake
 * ```typescript
 * const zone = yield* GCP.Dataplex.LakesZone("Landing", {
 *   lake: lake.name,
 *   type: "RAW",
 *   labels: { env: "dev" },
 * });
 * ```
 *
 * **Example:** Named zone with discovery disabled
 * ```typescript
 * const zone = yield* GCP.Dataplex.LakesZone("Landing", {
 *   lake: lake.name,
 *   zoneId: "landing-raw",
 *   discoverySpec: { enabled: false },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const LakesZone = Resource<LakesZone>("GCP.Dataplex.LakesZone");

export class LakesZoneNotResolved extends Data.TaggedError(
  "GCP.Dataplex.LakesZoneNotResolved",
)<{
  name: string;
}> {}

export class LakesZoneStillExists extends Data.TaggedError(
  "GCP.Dataplex.LakesZoneStillExists",
)<{
  name: string;
}> {}

const lakeOf = (lake: string, project: string, location: string) =>
  expandParent(lake, project, location, "lakes");

const resourceName = (lake: string, zoneId: string) =>
  `${lake}/zones/${zoneId}`;

const desiredType = (type: string | undefined) =>
  (type ?? DEFAULT_TYPE).toUpperCase();

const desiredLocationType = (value: string | undefined) =>
  (value ?? DEFAULT_LOCATION_TYPE).toUpperCase();

const discoveryBody = (
  spec: ZoneDiscoverySpec | undefined,
): dataplex.GoogleCloudDataplexV1ZoneDiscoverySpec => ({
  enabled: spec?.enabled === true,
  includePatterns: spec?.includePatterns,
  excludePatterns: spec?.excludePatterns,
  csvOptions: spec?.csvOptions,
  jsonOptions: spec?.jsonOptions,
  schedule: spec?.schedule,
});

const toAttrs = (zone: dataplex.GoogleCloudDataplexV1Zone, project: string) => {
  const name = zone.name ?? "";
  const parsed = parseResourceName(name, "zones");
  return {
    name,
    zoneId: parsed.id,
    lake: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    type: zone.type ?? DEFAULT_TYPE,
    locationType: zone.resourceSpec?.locationType ?? DEFAULT_LOCATION_TYPE,
    displayName: zone.displayName,
    description: zone.description,
    labels: userLabels(zone.labels),
    discoveryEnabled: zone.discoverySpec?.enabled === true,
    state: zone.state,
    uid: zone.uid,
    createTime: zone.createTime,
    updateTime: zone.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataplex
        .getProjectsLocationsLakesZones({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (zone): zone is dataplex.GoogleCloudDataplexV1Zone => zone !== undefined,
      () => new LakesZoneNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (zone) => !isPendingState(zone.state),
      () => new DataplexNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Dataplex.LakesZoneNotResolved" ||
        error._tag === "GCP.Dataplex.NotResolved" ||
        error._tag === "TooManyRequests",
      // Lakes provision a metastore-backed control plane for 2-5 minutes.
      times: 36,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((zone) =>
      zone === undefined
        ? Effect.void
        : Effect.fail(new LakesZoneStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataplex.LakesZoneStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const LakesZoneProvider = () =>
  Provider.succeed(LakesZone, {
    stables: [
      "name",
      "zoneId",
      "lake",
      "project",
      "location",
      "type",
      "locationType",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.zoneId ?? output?.zoneId;
      const nextId = news.zoneId ?? previousId;
      const previousLake = olds?.lake ?? output?.lake;
      const nextLake = news.lake ?? previousLake;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousType = desiredType(olds?.type ?? output?.type);
      const nextType = desiredType(news.type ?? previousType);
      const previousLocationType = desiredLocationType(
        olds?.locationType ?? output?.locationType,
      );
      const nextLocationType = desiredLocationType(
        news.locationType ?? previousLocationType,
      );
      if (
        replaceIfChanged(previousId, nextId) ||
        replaceIfChanged(previousLake, nextLake) ||
        (output !== undefined && previousLocation !== nextLocation) ||
        previousType !== nextType ||
        previousLocationType !== nextLocationType
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLake === nextLake &&
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const lake = lakeOf(
        olds?.lake ?? output?.lake ?? "",
        env.project,
        location,
      );
      const zoneId = yield* toPhysicalRfc1035(id, olds?.zoneId, output?.zoneId);
      const name = output?.name ?? resourceName(lake, zoneId);
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
        const lakes = yield* listLakes(env.project, env.region);
        const zones = yield* listChildResources(lakes, listZones);
        return zones
          .filter((zone) => hasAlchemyLabelMap(zone.labels))
          .map((zone) => toAttrs(zone, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const lake = lakeOf(news.lake, env.project, location);
      const zoneId = yield* toPhysicalRfc1035(id, news.zoneId, output?.zoneId);
      const name = output?.name ?? resourceName(lake, zoneId);
      const type = desiredType(news.type);
      const locationType = desiredLocationType(news.locationType);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredDiscovery = discoveryBody(news.discoverySpec);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsLakesZones({
            parent: lake,
            zoneId,
            body: {
              type,
              resourceSpec: { locationType },
              displayName: news.displayName,
              description: news.description,
              labels: desiredLabels,
              discoverySpec: desiredDiscovery,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new LakesZoneNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const discoveryChanged =
        fingerprint(current.discoverySpec) !== fingerprint(desiredDiscovery);

      if (
        labelsChanged ||
        displayNameChanged ||
        descriptionChanged ||
        discoveryChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "display_name" : undefined,
          descriptionChanged ? "description" : undefined,
          discoveryChanged ? "discovery_spec" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation = yield* dataplex.patchProjectsLocationsLakesZones({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            displayName: news.displayName,
            description: news.description,
            labels: desiredLabels,
            discoverySpec: desiredDiscovery,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name || output.name.includes("//")) return;
      const operation = yield* dataplex
        .deleteProjectsLocationsLakesZones({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("BadRequest", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
