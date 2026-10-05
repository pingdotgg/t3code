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
  fingerprint,
  hasAlchemyLabelMap,
  isPendingState,
  listAssets,
  listChildResources,
  listLakes,
  listZones,
  normalizeLocation,
  parseResourceName,
  replaceIfChanged,
  toPhysicalRfc1035,
  userLabels,
} from "./shared.ts";

export type AssetResourceSpec = {
  /**
   * Relative name of the attached cloud resource
   * (`projects/{project}/buckets/{bucket}` or
   * `projects/{project}/datasets/{dataset}`). Immutable — changing it
   * replaces the asset.
   */
  name?: string;
  /**
   * Resource type. Immutable — changing it replaces the asset.
   */
  type: dataplex.GoogleCloudDataplexV1AssetResourceSpecTypeEnum | (string & {});
  /**
   * Read access mode for Cloud Storage bucket assets (`DIRECT` or
   * `MANAGED`).
   */
  readAccessMode?:
    | dataplex.GoogleCloudDataplexV1AssetResourceSpecReadAccessModeEnum
    | (string & {});
};

export type AssetDiscoverySpec = {
  /** Whether discovery is enabled. */
  enabled?: boolean;
  /** Include glob / table-name patterns. */
  includePatterns?: string[];
  /** Exclude glob / table-name patterns. */
  excludePatterns?: string[];
  /** CSV discovery options. */
  csvOptions?: {
    headerRows?: number;
    delimiter?: string;
    encoding?: string;
    disableTypeInference?: boolean;
  };
  /** JSON discovery options. */
  jsonOptions?: {
    encoding?: string;
    disableTypeInference?: boolean;
  };
  /** Cron schedule (at least 60 minutes apart). */
  schedule?: string;
};

export type LakesAssetProps = {
  /**
   * Parent zone. Full name
   * `projects/{project}/locations/{location}/lakes/{lake}/zones/{zone}`.
   * Immutable — changing it replaces the asset.
   */
  zone: string;
  /**
   * Region used when constructing names. Taken from `zone` when it is a
   * full resource name.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Asset id. Must contain only lowercase letters, numbers, and hyphens;
   * start with a letter; end with a letter or number; and be 1-63
   * characters. Immutable — changing it replaces the asset.
   */
  assetId?: string;
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
   * Cloud resource this asset manages.
   */
  resourceSpec: AssetResourceSpec;
  /**
   * Discovery settings. When omitted, the parent zone spec is used.
   */
  discoverySpec?: AssetDiscoverySpec;
};

export type LakesAsset = Resource<
  "GCP.Dataplex.LakesAsset",
  LakesAssetProps,
  {
    /** Full resource name `.../zones/{zone}/assets/{asset}`. */
    name: string;
    /** Asset id. */
    assetId: string;
    /** Parent zone resource name. */
    zone: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Attached resource type. */
    resourceType: string | undefined;
    /** Attached resource name. */
    resourceName: string | undefined;
    /** Resource status (`READY`, `ERROR`, …). */
    resourceState: string | undefined;
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
 * A Dataplex asset — a Cloud Storage bucket or BigQuery dataset managed
 * inside a lake zone.
 *
 * Changing `zone`, `assetId`, `location`, or the attached resource
 * (`resourceSpec.name` / `type`) replaces the asset. Display name,
 * description, labels, and discovery spec update in place.
 *
 * ### Creating an Asset
 * **Example:** Cloud Storage bucket asset
 * ```typescript
 * const asset = yield* GCP.Dataplex.LakesAsset("RawBucket", {
 *   zone: zone.name,
 *   resourceSpec: {
 *     type: "STORAGE_BUCKET",
 *     name: `projects/${projectNumber}/buckets/${bucket.bucketName}`,
 *   },
 *   labels: { env: "dev" },
 * });
 * ```
 *
 * **Example:** Named asset with discovery disabled
 * ```typescript
 * const asset = yield* GCP.Dataplex.LakesAsset("RawBucket", {
 *   zone: zone.name,
 *   assetId: "landing-bucket",
 *   resourceSpec: {
 *     type: "STORAGE_BUCKET",
 *     name: `projects/${projectNumber}/buckets/${bucket.bucketName}`,
 *   },
 *   discoverySpec: { enabled: false },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const LakesAsset = Resource<LakesAsset>("GCP.Dataplex.LakesAsset");

export class LakesAssetNotResolved extends Data.TaggedError(
  "GCP.Dataplex.LakesAssetNotResolved",
)<{
  name: string;
}> {}

export class LakesAssetStillExists extends Data.TaggedError(
  "GCP.Dataplex.LakesAssetStillExists",
)<{
  name: string;
}> {}

const zoneOf = (zone: string) => zone;

const resourceNameOf = (zone: string, assetId: string) =>
  `${zone}/assets/${assetId}`;

const toAttrs = (
  asset: dataplex.GoogleCloudDataplexV1Asset,
  project: string,
) => {
  const name = asset.name ?? "";
  const parsed = parseResourceName(name, "assets");
  return {
    name,
    assetId: parsed.id,
    zone: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: asset.displayName,
    description: asset.description,
    labels: userLabels(asset.labels),
    resourceType: asset.resourceSpec?.type,
    resourceName: asset.resourceSpec?.name,
    resourceState: asset.resourceStatus?.state,
    state: asset.state,
    uid: asset.uid,
    createTime: asset.createTime,
    updateTime: asset.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0 || name.includes("//")
    ? Effect.succeed(undefined)
    : dataplex
        .getProjectsLocationsLakesZonesAssets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (asset): asset is dataplex.GoogleCloudDataplexV1Asset =>
        asset !== undefined,
      () => new LakesAssetNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (asset) => !isPendingState(asset.state),
      () => new DataplexNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Dataplex.LakesAssetNotResolved" ||
        error._tag === "GCP.Dataplex.NotResolved" ||
        error._tag === "TooManyRequests",
      // Asset discovery settles in 1-3 minutes, longer while the lake is busy.
      times: 36,
      schedule: Schedule.spaced("10 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((asset) =>
      asset === undefined
        ? Effect.void
        : Effect.fail(new LakesAssetStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataplex.LakesAssetStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const listOwnedAssets = (project: string, region: string) =>
  Effect.gen(function* () {
    const lakes = yield* listLakes(project, region);
    const zones = yield* listChildResources(lakes, listZones);
    const assets = yield* Effect.forEach(
      zones.filter((zone) => (zone.name ?? "").length > 0),
      (zone) => listAssets(zone.name!),
      { concurrency: 4 },
    );
    return assets.flat();
  });

export const LakesAssetProvider = () =>
  Provider.succeed(LakesAsset, {
    stables: [
      "name",
      "assetId",
      "zone",
      "project",
      "location",
      "resourceType",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.assetId ?? output?.assetId;
      const nextId = news.assetId ?? previousId;
      const previousZone = olds?.zone ?? output?.zone;
      const nextZone = news.zone ?? previousZone;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousType = (
        olds?.resourceSpec?.type ??
        output?.resourceType ??
        ""
      ).toUpperCase();
      const nextType = (news.resourceSpec.type ?? previousType).toUpperCase();
      const previousResource =
        olds?.resourceSpec?.name ?? output?.resourceName ?? "";
      const nextResource = news.resourceSpec.name ?? previousResource;
      if (
        replaceIfChanged(previousId, nextId) ||
        replaceIfChanged(previousZone, nextZone) ||
        (output !== undefined && previousLocation !== nextLocation) ||
        previousType !== nextType ||
        previousResource !== nextResource
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousZone === nextZone &&
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const zone = zoneOf(olds?.zone ?? output?.zone ?? "");
      const assetId = yield* toPhysicalRfc1035(
        id,
        olds?.assetId,
        output?.assetId,
      );
      const name = output?.name ?? resourceNameOf(zone, assetId);
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
        const assets = yield* listOwnedAssets(env.project, env.region);
        return assets
          .filter((asset) => hasAlchemyLabelMap(asset.labels))
          .map((asset) => toAttrs(asset, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const zone = zoneOf(news.zone);
      const assetId = yield* toPhysicalRfc1035(
        id,
        news.assetId,
        output?.assetId,
      );
      const name = output?.name ?? resourceNameOf(zone, assetId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const resourceSpec: dataplex.GoogleCloudDataplexV1AssetResourceSpec = {
        name: news.resourceSpec.name,
        type: news.resourceSpec.type,
        readAccessMode: news.resourceSpec.readAccessMode,
      };
      const discoverySpec = news.discoverySpec
        ? {
            enabled: news.discoverySpec.enabled,
            includePatterns: news.discoverySpec.includePatterns,
            excludePatterns: news.discoverySpec.excludePatterns,
            csvOptions: news.discoverySpec.csvOptions,
            jsonOptions: news.discoverySpec.jsonOptions,
            schedule: news.discoverySpec.schedule,
          }
        : undefined;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsLakesZonesAssets({
            parent: zone,
            assetId,
            body: {
              displayName: news.displayName,
              description: news.description,
              labels: desiredLabels,
              resourceSpec,
              discoverySpec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new LakesAssetNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const discoveryChanged =
        discoverySpec !== undefined &&
        fingerprint(current.discoverySpec) !== fingerprint(discoverySpec);
      const readModeChanged =
        (news.resourceSpec.readAccessMode ?? "") !==
        (current.resourceSpec?.readAccessMode ?? "");

      if (
        labelsChanged ||
        displayNameChanged ||
        descriptionChanged ||
        discoveryChanged ||
        readModeChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "display_name" : undefined,
          descriptionChanged ? "description" : undefined,
          discoveryChanged ? "discovery_spec" : undefined,
          readModeChanged ? "resource_spec.read_access_mode" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation =
          yield* dataplex.patchProjectsLocationsLakesZonesAssets({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              displayName: news.displayName,
              description: news.description,
              labels: desiredLabels,
              resourceSpec,
              discoverySpec,
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
        .deleteProjectsLocationsLakesZonesAssets({ name: output.name })
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
